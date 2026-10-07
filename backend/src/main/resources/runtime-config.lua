-- Schema 3: one bounded document, ONE mutating Redis command.
-- Encode the document AND response before SET. Lua isolation is not rollback.
-- No command, allocation or JSON encoding after a successful SET.
local mode, expected, candidate = ARGV[1], ARGV[2], ARGV[3]
local operationId, instanceId = ARGV[4], ARGV[5]
local RECEIPT_MS, HISTORY_MS, MAX_RECEIPTS, MAX_HISTORY = 86400000, 604800000, 512, 100
local function result(status, snapshot)
    return cjson.encode({status=status, snapshot=snapshot})
end
local function uuid(s)
    return type(s)=='string' and #s==36 and string.match(s,'^[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+$')
        and string.sub(s,9,9)=='-' and string.sub(s,14,14)=='-'
        and string.sub(s,19,19)=='-' and string.sub(s,24,24)=='-'
end
local function version(value)
    if type(value) ~= 'string' then return nil end
    local epoch, revision = string.match(value, '^([0-9a-f%-]+):([1-9][0-9]*)$')
    local number = tonumber(revision)
    if not uuid(epoch) or not number or number > 9007199254740991
        or string.format('%.0f', number) ~= revision then return nil end
    return epoch, number
end
local function decode(raw)
    local ok, value = pcall(cjson.decode, raw)
    if ok and type(value) == 'table' then return value end
end
local function count(t)
    if type(t)~='table' then return -1 end
    local n=0; for _ in pairs(t) do n=n+1 end; return n
end
local ranges = {replenishRate=10000, burstCapacity=10000, requestedTokens=100,
    monitorWindowSeconds=120, emitIntervalSeconds=5}
local function valuesValid(value)
    if type(value)~='table' or type(value.rateLimitEnabled) ~= 'boolean' then return false end
    for key, max in pairs(ranges) do
        local n = value[key]
        if type(n) ~= 'number' or n ~= math.floor(n) or n < 1 or n > max then return false end
    end
    return true
end
local function values(v)
    local out={rateLimitEnabled=v.rateLimitEnabled}
    for k in pairs(ranges) do out[k]=v[k] end
    return out
end
local function snapshot(v)
    local out=values(v);out.version=v.version;return out
end
local function same(a,b)
    if a.rateLimitEnabled~=b.rateLimitEnabled then return false end
    for k in pairs(ranges) do if a[k]~=b[k] then return false end end
    return true
end
local function snapshotValid(v)
    return valuesValid(v) and count(v)==7 and version(v.version)~=nil
end
local function integer(n)
    return type(n)=='number' and n>0 and n<=9007199254740991 and n==math.floor(n)
end
local function referenceValid(s, recorded)
    return type(s)=='table' and count(s)==(recorded and 3 or 2) and uuid(s.operationId)
        and version(s.version)~=nil and (not recorded or integer(s.recordedAt))
end
local function sameSource(a,b)
    return a.version==b.version and a.operationId==b.operationId
end
local function receiptValid(r, schema)
    if type(r)~='table' or not uuid(r.operationId) or not uuid(r.instanceId)
        or not version(r.expectedVersion) or not valuesValid(r.request) or count(r.request)~=6
        or not integer(r.recordedAt) or r.expiresAt~=r.recordedAt+RECEIPT_MS
        or not snapshotValid(r.before) then return false end
    local size=9
    if schema==3 then
        size=10
        if r.operationType=='rollback' then
            if not referenceValid(r.source,true) then return false end
            local sourceEpoch,sourceRevision=version(r.source.version)
            local beforeEpoch,beforeRevision=version(r.before.version)
            if r.source.recordedAt>r.recordedAt or sourceEpoch~=beforeEpoch or sourceRevision>beforeRevision then return false end
            size=11
        elseif r.operationType~='update' then return false end
    end
    if r.status=='rejected' then
        return count(r)==size and r.code=='CONFIG_VERSION_CONFLICT' and r.expectedVersion~=r.before.version
    end
    if r.status~='committed' or count(r)~=size or not snapshotValid(r.after) then return false end
    local epoch,revision=version(r.before.version)
    return r.expectedVersion==r.before.version and same(r.request,r.after)
        and r.after.version==epoch..':'..string.format('%.0f',revision+1)
end
local function valid(v,schema)
    if not valuesValid(v) then return false end
    if schema==0 then return count(v)==6 end
    if not version(v.version) or v.schemaVersion~=schema then return false end
    if schema==1 then return count(v)==8 end
    if count(v)~=10 or count(v.operations)<0 or count(v.operations)>MAX_RECEIPTS
        or count(v.history)<0 or count(v.history)>MAX_HISTORY then return false end
    for id,r in pairs(v.operations) do
        if not receiptValid(r,schema) or id~=r.operationId then return false end
    end
    if count(v.history)~=#v.history then return false end
    local last=9007199254740992
    for _,r in ipairs(v.history) do
        if not receiptValid(r,schema) or r.status~='committed' then return false end
        local _,rev=version(r.after.version)
        if rev>=last then return false end
        last=rev
    end
    return true
end
local function write(value, response)
    local encoded = cjson.encode(value)
    local reply = cjson.encode(response)
    local rejected = result('rejected') -- precomputed too
    local written = redis.pcall('SET', KEYS[1], encoded)
    if type(written) == 'table' and written.err then return rejected end
    return reply
end
local raw = redis.pcall('GET', KEYS[1])
if type(raw) == 'table' and raw.err then return result('invalid') end
if raw and #raw>2097152 then return result('invalid') end
local current = raw and decode(raw) or nil
if mode == 'init' then
    if raw and valid(current,3) then return result('ok',snapshot(current)) end
    if raw and valid(current,2) then
        -- Migration preserves every original operation identity, timestamp, value and version.
        for _,r in pairs(current.operations) do r.operationType='update' end
        for _,r in ipairs(current.history) do r.operationType='update' end
        current.schemaVersion=3
        return write(current,{status='ok',snapshot=snapshot(current)})
    end
    if raw and not valid(current,1) and not valid(current,0) then return result('invalid') end
    local initial = raw and current or decode(candidate)
    if not initial or (not valid(initial,1) and not valid(initial,0)) or not version(expected) then return result('invalid') end
    initial.version = initial.version or expected -- preserve the schema-1 generation and revision
    initial.schemaVersion,initial.operations,initial.history=3,{},{}
    return write(initial,{status='ok',snapshot=snapshot(initial)})
end
-- Queries never rebuild missing keys and never invent negative evidence.
if not raw then
    if mode=='operation' then return cjson.encode({status='unknown',reason='storage-missing',operationId=operationId}) end
    return result('missing')
end
if not valid(current,3) then return result('invalid') end
if mode == 'read' then return result('ok', snapshot(current)) end
local time = redis.pcall('TIME')
if type(time)=='table' and time.err then return result('rejected') end
local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
if mode=='operation' then
    local r=current.operations[operationId]
    if not r or r.expiresAt<=now then
        return cjson.encode({status='unknown',reason='no-available-receipt',operationId=operationId,checkedAt=now})
    end
    return cjson.encode({status=r.status,receipt=r,checkedAt=now})
end
if mode=='history' then
    local limit=tonumber(candidate)
    local epoch,upper
    if expected~='' then epoch,upper=version(expected) end
    local currentEpoch,currentRevision=version(current.version)
    if not limit or limit<1 or limit>50 or limit~=math.floor(limit) then return result('bad-query') end
    if expected~='' and (not epoch or epoch~=currentEpoch) then return result('cursor-invalid') end
    -- Exclusive keyset boundary. New commits cannot move subsequent pages.
    local entries,more={},false
    for _,r in ipairs(current.history) do
        local _,revision=version(r.after.version)
        if r.recordedAt+HISTORY_MS>now and (not upper or revision<upper) then
            if #entries<limit then table.insert(entries,r) else more=true;break end
        end
    end
    local cursor=cjson.null
    if more then cursor=entries[#entries].after.version end
    return cjson.encode({status='ok',entries=entries,nextCursor=cursor,checkedAt=now,
        retention={receiptMs=RECEIPT_MS,historyMs=HISTORY_MS,maxHistory=MAX_HISTORY,maxReceipts=MAX_RECEIPTS}})
end
local function historical(source)
    for _,r in ipairs(current.history) do
        if r.operationId==source.operationId and r.after.version==source.version and r.recordedAt<=now and r.recordedAt+HISTORY_MS>now then
            local sourceEpoch,sourceRevision=version(r.after.version)
            local currentEpoch,currentRevision=version(current.version)
            if sourceEpoch==currentEpoch and sourceRevision<=currentRevision then return r end
        end
    end
end
local proposed=decode(candidate)
if mode=='rollback-preview' then
    if not referenceValid(proposed,false) then return result('bad-request') end
    local target=historical(proposed)
    if not target then return result('history-unavailable') end
    return cjson.encode({status='ok',current=snapshot(current),target=target.after,
        source={version=target.after.version,operationId=target.operationId,recordedAt=target.recordedAt},
        checkedAt=now,noChanges=same(current,target.after)})
end
if mode~='write' and mode~='rollback' then return result('invalid') end
local kind=mode=='rollback' and 'rollback' or 'update'
if not uuid(operationId) or not uuid(instanceId) or not version(expected) then return result('bad-request') end
if kind=='update' and (not valuesValid(proposed) or count(proposed)~=6) then return result('bad-request') end
if kind=='rollback' and not referenceValid(proposed,false) then return result('bad-request') end
-- Match the original operation BEFORE checking whether its history source is still retained.
local existing=current.operations[operationId]
if existing and existing.expiresAt>now then
    if existing.operationType~=kind or existing.expectedVersion~=expected
        or (kind=='update' and not same(existing.request,proposed))
        or (kind=='rollback' and not sameSource(existing.source,proposed)) then return result('operation-mismatch') end
    return cjson.encode({status=existing.status=='committed' and 'ok' or 'conflict',
        snapshot=existing.status=='committed' and existing.after or existing.before,receipt=existing,replayed=true})
end
local source
if kind=='rollback' then
    local target=historical(proposed)
    if not target then return result('history-unavailable') end
    source={version=target.after.version,operationId=target.operationId,recordedAt=target.recordedAt}
    proposed=values(target.after) -- exclusively from the authoritative document, never client values
end
local retained,n={},0
for id,r in pairs(current.operations) do
    if r.expiresAt>now then retained[id]=r;n=n+1 end
end
if n>=MAX_RECEIPTS then return result('receipt-capacity') end
local r={operationType=kind,operationId=operationId,instanceId=instanceId,expectedVersion=expected,
    request=values(proposed),before=snapshot(current),recordedAt=now,expiresAt=now+RECEIPT_MS}
if source then r.source=source end
local conflict=current.version~=expected
if conflict then r.status='rejected';r.code='CONFIG_VERSION_CONFLICT'
else
    local epoch,revision=version(current.version)
    if revision>=9007199254740991 then return result('exhausted') end
    r.status='committed';r.after=values(proposed)
    r.after.version=epoch..':'..string.format('%.0f',revision+1)
end
retained[operationId]=r
local history={}
if not conflict then table.insert(history,r) end
for _,entry in ipairs(current.history) do
    if #history<MAX_HISTORY and entry.recordedAt+HISTORY_MS>now then table.insert(history,entry) end
end
local next=conflict and snapshot(current) or snapshot(r.after)
next.schemaVersion,next.operations,next.history=3,retained,history
return write(next,{status=conflict and 'conflict' or 'ok',
    snapshot=conflict and r.before or r.after,receipt=r,replayed=false})
