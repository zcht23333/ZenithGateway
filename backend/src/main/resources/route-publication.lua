-- One authority. Initialization writes snapshot + persistent guard together; publishing uses one SET.
-- ARGV: mode, expected version, exact observed JSON, fully validated/compiled candidate JSON.
local function reply(status,raw) return cjson.encode({status=status,snapshot=raw or cjson.null}) end
local kind=redis.call('TYPE',KEYS[1]).ok
if kind=='hash' then return reply('legacy') end
if kind~='none' and kind~='string' then return reply('invalid') end
if kind=='string' and redis.call('STRLEN',KEYS[1])>262144 then return reply('invalid') end
local raw=redis.call('GET',KEYS[1])
local guard=redis.pcall('GET',KEYS[2])
if type(guard)=='table' then return reply('invalid') end
if not raw then
 if ARGV[1]~='boot' or guard then return reply('missing') end
 local ok,initial=pcall(cjson.decode,ARGV[4])
 if not ok or type(initial)~='table' or type(initial.version)~='string' then return reply('invalid') end
 local written=redis.pcall('MSET',KEYS[1],ARGV[4],KEYS[2],string.sub(initial.version,1,36))
 if type(written)=='table' and written.err then return reply('rejected') end
 return reply('ok',ARGV[4])
end
local ok,current=pcall(cjson.decode,raw)
if not ok or type(current)~='table' or current.schemaVersion~=1 or type(current.version)~='string'
 or not guard or guard~=string.sub(current.version,1,36) then return reply('invalid') end
if ARGV[1]=='read' or ARGV[1]=='boot' then return reply('ok',raw) end
if ARGV[1]~='write' then return reply('invalid') end
if current.version~=ARGV[2] then return reply('conflict',raw) end
-- Full Java validation/build happened against these exact bytes; never publish over unseen state.
if raw~=ARGV[3] then return reply('changed',raw) end
local success,next=pcall(cjson.decode,ARGV[4])
local revision=tonumber(string.sub(current.version,38))
if not success or type(next)~='table' or next.schemaVersion~=1 or not revision or revision>=9007199254740991
 or next.version~=guard..':'..string.format('%.0f',revision+1) or string.len(ARGV[4])>262144 then return reply('invalid') end
local written=redis.pcall('SET',KEYS[1],ARGV[4])
if type(written)=='table' and written.err then return reply('rejected') end
return reply('ok',ARGV[4])
