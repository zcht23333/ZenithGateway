package com.zch.route;
import com.zch.config.*;
import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

@EnabledIfEnvironmentVariable(named="ZENITH_TEST_REDIS_PORT",matches="[0-9]+")
class RoutePublicationRedisTest {
    final JsonMapper mapper=JsonMapper.builder().build();String key;RedisClient redis;StatefulRedisConnection<String,String> connection;RouteStore A,B;
    @BeforeEach void open()throws Exception{
        key="zg:route-test:"+UUID.randomUUID();int port=Integer.parseInt(System.getenv("ZENITH_TEST_REDIS_PORT"));
        redis=RedisClient.create("redis://127.0.0.1:"+port);connection=redis.connect();
        var props=new DataRedisProperties();props.setPort(port);props.setHost("127.0.0.1");
        var runtime=new GatewayRuntimeProperties();runtime.getRoute().setRedisKey(key);
        A=new RouteStore(props,runtime,new RuntimeConfigSyncProperties(),new RoutePublicationProperties(),mapper);
        B=new RouteStore(props,runtime,new RuntimeConfigSyncProperties(),new RoutePublicationProperties(),mapper);
    }
    @AfterEach void close(){A.destroy();B.destroy();connection.sync().del(key,key+":guard");connection.close();redis.shutdown();}
    private RouteRuleDto rule(String uri){var r=new RouteRuleDto();r.setId("shared");r.setPath("/shared/**");r.setUri(uri);return r;}
    @Test void twoColdStartsAgreeOnOneEmptySnapshot()throws Exception{
        var pool=Executors.newFixedThreadPool(2);var barrier=new CyclicBarrier(2);
        try{var a=pool.submit(()->{barrier.await();return A.read(true,true).snapshot();});var b=pool.submit(()->{barrier.await();return B.read(true,true).snapshot();});
            var first=a.get(3,TimeUnit.SECONDS);assertEquals(first,b.get(3,TimeUnit.SECONDS));assertTrue(first.routes().isEmpty());assertEquals(first.epoch(),connection.sync().get(key+":guard"));}
        finally{pool.shutdownNow();}
    }
    @Test void concurrentSameVersionPublishesAtMostOnce()throws Exception{
        var base=A.read(true,false);var barrier=new CyclicBarrier(2);var pool=Executors.newFixedThreadPool(2);
        try{
            var calls=new ArrayList<Future<Object>>();
            for(var pair:List.of(Map.entry(A,"http://127.0.0.1:9001"),Map.entry(B,"http://127.0.0.1:9002")))calls.add(pool.submit(()->{barrier.await();try{return pair.getKey().publish(base,base.snapshot().change(rule(pair.getValue()),null));}catch(RouteProblem p){return p;}}));
            var results=new ArrayList<Object>();for(var f:calls)results.add(f.get(3,TimeUnit.SECONDS));
            assertEquals(1,results.stream().filter(RouteStore.Stored.class::isInstance).count());assertEquals(1,results.stream().filter(x->x instanceof RouteProblem p&&p.status()==409).count());assertEquals(2,A.read(false,false).snapshot().revision());
        }finally{pool.shutdownNow();}
    }
    @Test void editDeleteAndRecreateCannotBeOverwrittenByOldRequests(){
        var empty=A.read(true,false);var first=A.publish(empty,empty.snapshot().change(rule("http://host:9001"),null));
        var deleted=B.publish(first,first.snapshot().change(null,"shared"));assertTrue(deleted.snapshot().routes().isEmpty());
        var recreate=A.publish(deleted,deleted.snapshot().change(rule("http://host:9002"),null));
        assertEquals(409,assertThrows(RouteProblem.class,()->B.publish(first,first.snapshot().change(rule("http://host:9999"),null))).status());
        assertEquals(409,assertThrows(RouteProblem.class,()->B.publish(first,first.snapshot().change(null,"shared"))).status());assertEquals(recreate.snapshot(),A.read(false,false).snapshot());
    }
    @Test void missingAuthorityWithGuardNeverReinitializesEvenOnRestart(){
        A.read(true,false);connection.sync().del(key);
        for(boolean boot:List.of(false,true))assertEquals("ROUTE_STORAGE_MISSING",assertThrows(RouteProblem.class,()->B.read(boot,false)).response().get("code"));
        assertNull(connection.sync().get(key));assertNotNull(connection.sync().get(key+":guard"));
    }
    @ParameterizedTest @ValueSource(strings={"false","null","[]","{}","{bad"})
    void malformedAuthorityIsPreservedInsteadOfAdoptingAnEmptySet(String bad){
        A.read(true,false);connection.sync().set(key,bad);
        assertThrows(RouteProblem.class,()->A.read(false,false));assertThrows(RouteProblem.class,()->B.read(true,false));assertEquals(bad,connection.sync().get(key));
    }
    @Test void oldHashIsAnExplicitMigrationRequirement(){
        connection.sync().hset(key,"shared",mapper.writeValueAsString(rule("http://host")));
        assertEquals("ROUTE_STORAGE_LEGACY",assertThrows(RouteProblem.class,()->A.read(true,false)).response().get("code"));assertEquals("hash",connection.sync().type(key));
    }
    @Test void exactObservedBytesPreventPublishingOverUnseenSameVersionMutation(){
        var base=A.read(true,false);var raw=base.raw().replace("\"routes\":[]","\"routes\": []");assertNotEquals(base.raw(),raw);connection.sync().set(key,raw);
        assertEquals(409,assertThrows(RouteProblem.class,()->A.publish(base,base.snapshot().change(rule("http://host"),null))).status());assertEquals(raw,connection.sync().get(key));
    }
    @Test void independentRuntimeKeyIsNeverTouchedByRoutePublication(){
        String runtime=key+":runtime";connection.sync().set(runtime,"untouched");try{var base=A.read(true,false);A.publish(base,base.snapshot().change(rule("http://host"),null));assertEquals("untouched",connection.sync().get(runtime));}finally{connection.sync().del(runtime);}
    }
}
