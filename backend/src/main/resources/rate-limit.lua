-- Versioned token accounting. All time and decisions are inside this one Redis invocation.
-- KEYS: persistent namespace policy fence, expiring client bucket. No runtime config read.
local function error_reply(reason) return cjson.encode({outcome='redis_fail_open',reason=reason,execution='not_written',staleRequest=false}) end
local function integer(n,low,high) return type(n)=='number' and n==math.floor(n) and n>=low and n<=high end
local function version(v)
  if type(v)~='string' then return nil end
  local epoch,rev=string.match(v,'^([0-9a-f%-]+):([1-9][0-9]*)$')
  if not epoch or #epoch~=36 or not integer(tonumber(rev),1,9007199254740991) then return nil end
  return epoch,tonumber(rev)
end
local function policy(p)
  return type(p)=='table' and p.schema==2 and version(p.version) and integer(p.capacity,1,10000)
    and integer(p.rate,1,10000) and integer(p.cost,1,100)
end
local function read(key)
  local raw=redis.pcall('GET',key)
  if type(raw)=='table' then return nil,false end
  -- Only a missing Redis bulk reply means absence; JSON false is existing corrupt data.
  if raw==false then return nil,true end
  local ok,value=pcall(cjson.decode,raw)
  if not ok or type(value)~='table' then return nil,false end
  return value,true
end
local incoming={schema=2,version=ARGV[1],capacity=tonumber(ARGV[2]),rate=tonumber(ARGV[3]),cost=tonumber(ARGV[4])}
if not policy(incoming) then return error_reply('invalid_request') end
local fence,valid=read(KEYS[1]);if not valid or (fence and not policy(fence)) then return error_reply('policy_invalid') end
local bucket,valid=read(KEYS[2]);if not valid then return error_reply('bucket_invalid') end
if bucket and (type(bucket)~='table' or bucket.schema~=2 or not policy(bucket.policy) or not integer(bucket.tokensMilli,0,bucket.policy.capacity*1000)
 or not integer(bucket.billedTimeMs,0,9007199254740991)) then return error_reply('bucket_invalid') end
if bucket and not fence then return error_reply('policy_missing') end
local epoch,rev=version(incoming.version)
if fence then
 local fe,fr=version(fence.version)
 if epoch~=fe then return error_reply('epoch_mismatch') end
 if rev==fr and (incoming.capacity~=fence.capacity or incoming.rate~=fence.rate or incoming.cost~=fence.cost) then return error_reply('policy_conflict') end
 if rev<fr then incoming=fence end
end
if bucket then
 local be,br=version(bucket.policy.version);local pe,pr=version(incoming.version)
 if be~=pe then return error_reply('epoch_mismatch') end
 if br>pr then return error_reply('policy_behind_bucket') end
 if br==pr and (bucket.policy.capacity~=incoming.capacity or bucket.policy.rate~=incoming.rate or bucket.policy.cost~=incoming.cost) then return error_reply('policy_conflict') end
end
local time = redis.call('TIME')
local now = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
local billed=now
local tokens=incoming.capacity*1000
if bucket then
 billed=math.max(now,bucket.billedTimeMs)
 -- Clamp before multiplication: even a huge clock jump cannot overflow integer precision.
 local refill=math.min(billed-bucket.billedTimeMs,math.ceil(bucket.policy.capacity*1000/bucket.policy.rate))*bucket.policy.rate
 tokens=math.min(bucket.policy.capacity*1000,bucket.tokensMilli+refill)
 tokens=math.min(incoming.capacity*1000,tokens)
end
local outcome,reason,retry='allowed','quota_available',cjson.null
if incoming.cost>incoming.capacity then outcome='unfulfillable';reason='cost_exceeds_capacity'
elseif tokens<incoming.cost*1000 then
 outcome='limited';reason='quota_exhausted'
 retry=math.max(1,math.ceil((billed-now+math.ceil((incoming.cost*1000-tokens)/incoming.rate))/1000))
else tokens=tokens-incoming.cost*1000 end
-- Universal idle recovery horizon: max legal capacity / min legal rate + 1 second.
-- Config changes cannot shorten retention and resurrect an old policy/full bucket.
local expires=billed+10001000
local encoded=cjson.encode({schema=2,policy=incoming,tokensMilli=tokens,billedTimeMs=billed})
-- Validation/encoding precede mutation. Lua serializes execution, but does not roll back command errors.
-- A fence-only advance on a later SET failure is safe: no credit is added; the request degrades explicitly.
if not fence or fence.version~=incoming.version then redis.call('SET',KEYS[1],cjson.encode(incoming)) end
redis.call('SET',KEYS[2],encoded,'PXAT',string.format('%.0f',expires))
return cjson.encode({outcome=outcome,reason=reason,execution='confirmed',retryAfterSeconds=retry,
 version=incoming.version,tokensMilli=tokens,serverTimeMs=now,billedTimeMs=billed,expiresAtMs=expires,
 capacity=incoming.capacity,rate=incoming.rate,cost=incoming.cost,staleRequest=ARGV[1]~=incoming.version})
