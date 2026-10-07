package com.zch.route;

import io.lettuce.core.*;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import tools.jackson.databind.json.JsonMapper;

/** Offline maintenance only. Uses the exact Java route validator; never drops invalid legacy entries. */
public final class RouteStorageTool {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    public static void main(String[] args)throws Exception{
        if(args.length==0)throw new IllegalArgumentException("check|verify|migrate|rollback --host HOST --port PORT --key KEY [--maintenance --backup NEW_FILE]");
        Map<String,String> options=new HashMap<>();for(int i=1;i<args.length;i++){if(!args[i].startsWith("--"))throw new IllegalArgumentException("Invalid option");String k=args[i].substring(2);options.put(k,i+1<args.length&&!args[i+1].startsWith("--")?args[++i]:"true");}
        String mode=args[0],key=Objects.requireNonNull(options.get("key"),"--key required");
        if(!key.matches("[A-Za-z0-9:_.-]{1,200}"))throw new IllegalArgumentException("Invalid key");
        boolean writing=Set.of("migrate","rollback").contains(mode);
        if(writing&&(!"true".equals(options.get("maintenance"))||options.get("backup")==null))throw new IllegalArgumentException("Stop ALL old/new writers, then provide --maintenance and a new --backup file");
        var uri=RedisURI.create(options.getOrDefault("host","127.0.0.1"),Integer.parseInt(options.getOrDefault("port","6379")));uri.setDatabase(Integer.parseInt(options.getOrDefault("database","0")));uri.setTimeout(java.time.Duration.ofSeconds(3));
        String password=System.getenv("ROUTE_REDIS_PASSWORD"),user=System.getenv("ROUTE_REDIS_USER");if(user!=null)uri.setAuthentication(user,Objects.toString(password,""));else if(password!=null&&!password.isEmpty())uri.setAuthentication(password.toCharArray());
        var client=RedisClient.create(uri);try(var connection=client.connect()){
            var redis=connection.sync();String type=redis.type(key),guard=redis.get(key+":guard");
            var before=new LinkedHashMap<String,Object>();before.put("key",key);before.put("kind",type);before.put("guard",guard);
            RouteSnapshot target=null;Map<String,String> hash=new TreeMap<>();
            if(mode.equals("verify")||mode.equals("rollback")){
                if(!type.equals("string")||redis.strlen(key)>RouteSnapshot.MAX_BYTES)throw new IllegalStateException("Expected versioned snapshot");
                String raw=redis.get(key);var snapshot=RouteSnapshot.parse(raw,JSON);if(!snapshot.epoch().equals(guard))throw new IllegalStateException("Snapshot guard mismatch");before.put("raw",raw);target=snapshot;
                if(mode.equals("verify")){System.out.println(JSON.writeValueAsString(Map.of("mode",mode,"version",snapshot.version(),"routes",snapshot.routes().size(),"valid",true)));return;}
                for(var rule:snapshot.routes())hash.put(rule.id(),JSON.writeValueAsString(rule.dto()));
            }else if(mode.equals("check")||mode.equals("migrate")){
                if(type.equals("hash")){
                    if(redis.hlen(key)>RouteSnapshot.MAX_ROUTES)throw new IllegalStateException("Legacy route count exceeds 256");
                    for(String field:redis.hkeys(key))if(redis.hstrlen(key,field)>16384)throw new IllegalStateException("Oversized legacy entry: "+field);
                    hash=new TreeMap<>(redis.hgetall(key));
                }else if(!type.equals("none")||guard!=null&&!"true".equals(options.get("empty-legacy-confirmed")))throw new IllegalStateException("Expected legacy Hash or explicitly confirmed empty legacy set; do not repair authority loss automatically");
                before.put("entries",hash);
                List<RouteSnapshot.Rule> rules=new ArrayList<>();List<String> errors=new ArrayList<>();
                for(var entry:hash.entrySet())try{
                    var node=JSON.readTree(entry.getValue());
                    if(!node.isObject()||!node.path("id").isString()||!entry.getKey().equals(node.path("id").asString()))throw new IllegalArgumentException("Hash field differs from route ID");
                    for(String field:List.of("rewriteEnabled","circuitBreakerEnabled"))if(node.has(field)&&!node.path(field).isBoolean())throw new IllegalArgumentException("Invalid switch "+field);
                    rules.add(RouteSnapshot.Rule.from(JSON.treeToValue(node,RouteRuleDto.class)));
                }catch(Exception error){errors.add(entry.getKey()+": "+error.getMessage());}
                if(!errors.isEmpty())throw new IllegalArgumentException("Invalid legacy entries; NONE migrated: "+JSON.writeValueAsString(errors));
                target=new RouteSnapshot(1,UUID.randomUUID()+":1",rules);target.json(JSON);
                if(mode.equals("check")){System.out.println(JSON.writeValueAsString(Map.of("mode",mode,"routes",rules.size(),"valid",true,"candidate",target)));return;}
            }else throw new IllegalArgumentException("Unknown mode");
            Path backup=Path.of(options.get("backup"));
            try(var file=FileChannel.open(backup,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){
                ByteBuffer bytes=StandardCharsets.UTF_8.encode(JSON.writeValueAsString(before)+"\n");while(bytes.hasRemaining())file.write(bytes);file.force(true);
            }
            String result;
            if(mode.equals("migrate"))result=redis.eval(MIGRATE,ScriptOutputType.VALUE,new String[]{key,key+":guard"},JSON.writeValueAsString(before),target.json(JSON),target.epoch());
            else result=redis.eval(ROLLBACK,ScriptOutputType.VALUE,new String[]{key,key+":guard",key+":rollback-stage:"+UUID.randomUUID()},String.valueOf(before.get("raw")),guard,JSON.writeValueAsString(hash));
            if(!"ok".equals(result))throw new IllegalStateException("Maintenance not confirmed: "+result+"; inspect Redis and backup before retrying");
            System.out.println(JSON.writeValueAsString(Map.of("mode",mode,"routes",target.routes().size(),"sourceOrTargetVersion",target.version(),"backup",backup.toAbsolutePath().toString(),"result",result)));
        }finally{client.shutdown();}
    }
    private static final String MIGRATE="""
        local before=cjson.decode(ARGV[1]);local kind=redis.call('TYPE',KEYS[1]).ok
        local guard=redis.call('GET',KEYS[2]);local expected=before.guard
        if kind~=before.kind or (expected==cjson.null and guard~=false) or (expected~=cjson.null and expected~=guard) then return 'changed' end
        if kind=='hash' then
          local count=0;for k,v in pairs(before.entries) do count=count+1;if redis.call('HGET',KEYS[1],k)~=v then return 'changed' end end
          if redis.call('HLEN',KEYS[1])~=count then return 'changed' end
        elseif kind~='none' then return 'invalid' end
        redis.call('MSET',KEYS[1],ARGV[2],KEYS[2],ARGV[3]);return 'ok'
        """;
    private static final String ROLLBACK="""
        if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] then return 'changed' end
        if redis.call('EXISTS',KEYS[3])~=0 then return 'stage-exists' end
        local fields={};for k,v in pairs(cjson.decode(ARGV[3])) do table.insert(fields,k);table.insert(fields,v) end
        if #fields==0 then redis.call('DEL',KEYS[1]);return 'ok' end
        -- Build staging Hash first. Failed staging/rename leaves the authoritative snapshot intact.
        local result=redis.pcall('HSET',KEYS[3],unpack(fields));if type(result)=='table' and result.err then return 'rejected' end
        local renamed=redis.pcall('RENAME',KEYS[3],KEYS[1]);if type(renamed)=='table' and renamed.err then redis.call('DEL',KEYS[3]);return 'rejected' end
        -- Keep the guard: an accidental new binary must not initialize over an empty legacy rollback.
        return 'ok'
        """;
}
