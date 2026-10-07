-- Single-key CAS. All validation and JSON encoding precede the only write.
-- Redis 7.4 / Lua doubles: revisions are decimal strings bounded at 2^53 - 1.
local mode, expected, candidate = ARGV[1], ARGV[2], ARGV[3]
local function result(status, snapshot)
    return cjson.encode({status=status, snapshot=snapshot})
end
local function version(value)
    if type(value) ~= 'string' then return nil end
    local epoch, revision = string.match(value, '^([0-9a-f%-]+):([1-9][0-9]*)$')
    if not epoch or #epoch ~= 36 or string.sub(epoch,9,9) ~= '-'
        or string.sub(epoch,14,14) ~= '-' or string.sub(epoch,19,19) ~= '-'
        or string.sub(epoch,24,24) ~= '-' then return nil end
    local hex = string.gsub(epoch, '-', '')
    local number = tonumber(revision)
    if #hex ~= 32 or not string.match(hex, '^[0-9a-f]+$') or not number
        or number > 9007199254740991 or string.format('%.0f', number) ~= revision then return nil end
    return epoch, number
end
local function decode(raw)
    local ok, value = pcall(cjson.decode, raw)
    if ok and type(value) == 'table' then return value end
    return nil
end
local ranges = {replenishRate=10000, burstCapacity=10000, requestedTokens=100,
    monitorWindowSeconds=120, emitIntervalSeconds=5}
local function valid(value, metadata)
    if not value or type(value.rateLimitEnabled) ~= 'boolean' then return false end
    for key, max in pairs(ranges) do
        local n = value[key]
        if type(n) ~= 'number' or n ~= math.floor(n) or n < 1 or n > max then return false end
    end
    local count = 0
    for _ in pairs(value) do count = count + 1 end
    if metadata then
        return count == 8 and value.schemaVersion == 1 and version(value.version) ~= nil
    end
    return count == 6 and value.version == nil and value.schemaVersion == nil
end
local function write(value)
    local encoded = cjson.encode(value)
    local reply = result('ok', value)
    local written = redis.pcall('SET', KEYS[1], encoded)
    if type(written) == 'table' and written.err then return result('rejected') end
    return reply
end
local raw = redis.pcall('GET', KEYS[1])
if type(raw) == 'table' and raw.err then return result('invalid') end
local current = raw and decode(raw) or nil
if mode == 'init' then
    if raw and valid(current, true) then return result('ok', current) end
    if raw and not valid(current, false) then return result('invalid') end
    local initial = raw and current or decode(candidate)
    if not valid(initial, false) or not version(expected) then return result('invalid') end
    initial.schemaVersion = 1
    initial.version = expected
    return write(initial)
end
if not raw then return result('missing') end
if not valid(current, true) then return result('invalid') end
if mode == 'read' then return result('ok', current) end
if mode ~= 'write' then return result('invalid') end
if current.version ~= expected then return result('conflict', current) end
local next = decode(candidate)
if not valid(next, false) then return result('invalid') end
local epoch, revision = version(current.version)
if revision >= 9007199254740991 then return result('exhausted') end
next.schemaVersion = 1
next.version = epoch .. ':' .. string.format('%.0f', revision + 1)
return write(next)
