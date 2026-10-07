package com.zch.ratelimit;
import io.lettuce.core.*;
import io.lettuce.core.api.StatefulRedisConnection;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.core.io.ClassPathResource;
import java.nio.charset.StandardCharsets;
import java.util.*;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

@EnabledIfEnvironmentVariable(named="ZENITH_TEST_REDIS_PORT",matches="[0-9]+")
class RateLimitScriptIntegrationTest {
    RedisClient client;StatefulRedisConnection<String,String> redis;String key,script,fixture;final JsonMapper mapper=JsonMapper.builder().build();
    final String epoch="11111111-1111-1111-1111-111111111111";long time;
    @BeforeEach void setup() throws Exception {
        client=RedisClient.create("redis://127.0.0.1:"+System.getenv("ZENITH_TEST_REDIS_PORT"));redis=client.connect();key="zg:limiter:test:"+UUID.randomUUID();
        script=new ClassPathResource("rate-limit.lua").getContentAsString(StandardCharsets.UTF_8).replace("\r\n","\n");
        fixture=script.replace("local time = redis.call('TIME')\nlocal now = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)","local now = tonumber(ARGV[5])");
        assertNotEquals(script,fixture);time=System.currentTimeMillis()+10000;
    }
    @AfterEach void cleanup(){redis.sync().del(key+":policy",key+":bucket");redis.close();client.shutdown();}
    LimitDecision call(String version,int capacity,int rate,int cost,long now){
        String raw=redis.sync().eval(fixture,ScriptOutputType.VALUE,new String[]{key+":policy",key+":bucket"},version,""+capacity,""+rate,""+cost,""+now);
        return mapper.readValue(raw,LimitDecision.class);
    }
    LimitDecision call(int revision,int capacity,int rate,int cost,long now){return call(epoch+":"+revision,capacity,rate,cost,now);}
    @Test void clockRollbackCannotRepeatCredit(){
        assertEquals("allowed",call(1,2,2,2,time).outcome());assertEquals("allowed",call(1,2,2,2,time+1000).outcome());
        var backward=call(1,2,2,2,time);assertEquals(time+1000,backward.billedTimeMs());assertEquals("limited",backward.outcome());
        assertEquals("limited",call(1,2,2,2,time+1000).outcome());
    }
    @Test void exactMillitokensAccumulateWithoutFloatingPointRoundup(){
        call(1,1,3,1,time);assertEquals(999,call(1,1,3,1,time+333).tokensMilli());
        var next=call(1,1,3,1,time+334);assertEquals("allowed",next.outcome());assertEquals(0,next.tokensMilli());
    }
    @Test void deficitAndImpossibleCostHaveDifferentRetryContracts(){
        call(1,10,1,10,time);var denied=call(1,10,1,10,time+1);assertEquals(10,denied.retryAfterSeconds());
        var impossible=call(2,1,1,2,time+1);assertEquals("unfulfillable",impossible.outcome());assertNull(impossible.retryAfterSeconds());
    }
    @Test void policySwitchSettlesOldRateThenClampsAndNeverRestoresFullCredit(){
        call(1,10,2,5,time);var lower=call(2,4,1,2,time+500);assertEquals(2000,lower.tokensMilli());
        var grow=call(3,100,10,2,time+500);assertEquals(0,grow.tokensMilli());
        var stale=call(1,10,2,5,time+500);assertEquals("limited",stale.outcome());assertEquals(epoch+":3",stale.version());assertTrue(stale.staleRequest());
    }
    @Test void policyFenceSurvivesBucketCollectionAndRejectsOlderRequestStrategy(){
        call(3,2,1,2,time);redis.sync().del(key+":bucket");var recreated=call(1,100,10,1,time);
        assertEquals(2,recreated.capacity());assertEquals(2,recreated.cost());assertEquals(epoch+":3",recreated.version());
        assertEquals(-1,redis.sync().pttl(key+":policy"));
    }
    @Test void epochIsOnlyComparedForEqualityAndStorageRemainsUnchanged(){
        call(1,10,1,1,time);String before=redis.sync().get(key+":bucket");
        assertEquals("epoch_mismatch",call("ffffffff-ffff-ffff-ffff-ffffffffffff:1",10,1,1,time).reason());assertEquals(before,redis.sync().get(key+":bucket"));
    }
    @Test void corruptOrMissingFenceDoesNotResetExistingCredit(){
        call(1,10,1,1,time);redis.sync().del(key+":policy");assertEquals("policy_missing",call(1,10,1,1,time).reason());
        redis.sync().set(key+":policy","bad");assertEquals("policy_invalid",call(1,10,1,1,time).reason());
    }
    @Test void sameVersionDifferentValuesIsRejectedBeforeMutation(){
        call(1,10,1,1,time);String before=redis.sync().get(key+":bucket");assertEquals("policy_conflict",call(1,11,1,1,time).reason());assertEquals(before,redis.sync().get(key+":bucket"));
    }
    @Test void idleExpiryUsesTheMaximumLegalRecoveryHorizonIncludingClockDebt(){
        var first=call(1,1,1,1,time);assertEquals(time+10001000,first.expiresAtMs());
        var back=call(1,1,1,1,time-3000);assertEquals(first.expiresAtMs(),back.expiresAtMs());
        assertTrue(redis.sync().pttl(key+":bucket")>=10000000);
    }
    @Test void malformedBucketIsNotOverwrittenOrReinitialized(){
        call(1,10,1,1,time);redis.sync().set(key+":bucket","[]");assertEquals("bucket_invalid",call(1,10,1,1,time).reason());assertEquals("[]",redis.sync().get(key+":bucket"));
    }
    @Test void unknownBucketSchemaDoesNotSilentlyMigrateOrReset() {
        call(1,10,1,1,time);
        var node=(tools.jackson.databind.node.ObjectNode)mapper.readTree(redis.sync().get(key+":bucket"));
        node.put("schema",3);
        String unsupported=mapper.writeValueAsString(node);
        redis.sync().set(key+":bucket",unsupported);
        assertEquals("bucket_invalid",call(1,10,1,1,time).reason());
        assertEquals(unsupported,redis.sync().get(key+":bucket"));
    }
    @Test void aRateChangeUsesOldSpeedBeforeObservationAndNewSpeedAfterIt() {
        call(1,100,2,10,time);
        assertEquals(82000,call(2,100,8,10,time+1000).tokensMilli());
        assertEquals(76000,call(2,100,8,10,time+1500).tokensMilli());
    }

    // Format checks execute the unchanged production script, including Redis TIME.
    LimitDecision productionCall() {
        String raw=redis.sync().eval(script,ScriptOutputType.VALUE,
                new String[]{key+":policy",key+":bucket"},epoch+":1","20","1","1");
        return mapper.readValue(raw,LimitDecision.class);
    }
    void assertInvalid(LimitDecision decision,String reason) {
        assertEquals("redis_fail_open",decision.outcome());
        assertEquals(reason,decision.reason());
        assertEquals("not_written",decision.execution());
        assertNull(decision.tokensMilli());
        assertNull(decision.version());
        assertFalse(decision.staleRequest());
    }
    @ParameterizedTest(name="invalid bucket {0} stays unchanged")
    @ValueSource(strings={"false","null","true","0","\"text\"","[]","{}"})
    void invalidStoredJsonIsNeverAMissingBucket(String raw) {
        productionCall();
        String fence=redis.sync().get(key+":policy");
        redis.sync().set(key+":bucket",raw);
        assertInvalid(productionCall(),"bucket_invalid");
        assertEquals(raw,redis.sync().get(key+":bucket"));
        assertEquals(fence,redis.sync().get(key+":policy"));
    }
    @ParameterizedTest(name="invalid policy {0} stays unchanged with absent or existing bucket")
    @ValueSource(strings={"false","null","true","0","\"text\"","[]","{}"})
    void invalidStoredJsonIsNeverAMissingPolicy(String raw) {
        productionCall();
        String bucket=redis.sync().get(key+":bucket");
        redis.sync().set(key+":policy",raw);
        assertInvalid(productionCall(),"policy_invalid");
        assertEquals(raw,redis.sync().get(key+":policy"));
        assertEquals(bucket,redis.sync().get(key+":bucket"));
        redis.sync().del(key+":bucket");
        assertInvalid(productionCall(),"policy_invalid");
        assertEquals(raw,redis.sync().get(key+":policy"));
        assertNull(redis.sync().get(key+":bucket"));
    }
    @Test void trulyMissingPolicyAndBucketInitializeAndDebitOnce() {
        assertEquals(0,redis.sync().exists(key+":policy",key+":bucket"));
        var decision=productionCall();
        assertEquals("allowed",decision.outcome());
        assertEquals("confirmed",decision.execution());
        assertEquals(19000,decision.tokensMilli());
        assertEquals(epoch+":1",decision.version());
        assertEquals(19000,mapper.readTree(redis.sync().get(key+":bucket")).get("tokensMilli").asLong());
        assertEquals(epoch+":1",mapper.readTree(redis.sync().get(key+":policy")).get("version").asText());
    }
    @Test void trulyMissingBucketInitializesWithoutRewritingItsPolicy() {
        productionCall();
        String fence=redis.sync().get(key+":policy");
        redis.sync().del(key+":bucket");
        var decision=productionCall();
        assertEquals("allowed",decision.outcome());
        assertEquals("confirmed",decision.execution());
        assertEquals(19000,decision.tokensMilli());
        assertEquals(fence,redis.sync().get(key+":policy"));
        assertEquals(19000,mapper.readTree(redis.sync().get(key+":bucket")).get("tokensMilli").asLong());
    }
}
