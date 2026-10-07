package com.zch.ratelimit;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import static org.junit.jupiter.api.Assertions.*;
class LimitDecisionPolicyTest {
    @Test void localAndRedisPoliciesAreIndependentAndDefaultToCompatibility(){
        for(var local:LimiterProperties.FailurePolicy.values())for(var redis:LimiterProperties.FailurePolicy.values()){
            var p=new LimiterProperties();p.setLocalFailurePolicy(local);p.setRedisFailurePolicy(redis);p.validate();
            var l=LimitDecision.local("local_fail_open","queue_full","not_sent","executor_rejected").withPolicy(p);
            var r=LimitDecision.local("redis_fail_open","decision_timeout","unknown").withPolicy(p);
            assertEquals(local==LimiterProperties.FailurePolicy.ALLOW,l.forwards());
            assertEquals(redis==LimiterProperties.FailurePolicy.ALLOW,r.forwards());
            assertEquals("local_unavailable",l.event());assertEquals("redis_unconfirmed",r.event());
            assertEquals("unknown",r.execution());assertEquals("executor_rejected",l.rejectionSource());
            assertEquals(r,r.withPolicy(p));
        }
        assertTrue(LimitDecision.local("local_fail_open","queue_full","not_sent").withPolicy(new LimiterProperties()).forwards());
        assertTrue(LimitDecision.local("redis_fail_open","redis_error","unknown").withPolicy(new LimiterProperties()).forwards());
    }
    @Test void confirmedDecisionsAndCancellationDoNotChangeWithFaultPolicy(){
        var p=new LimiterProperties();p.setLocalFailurePolicy(LimiterProperties.FailurePolicy.REJECT);p.setRedisFailurePolicy(LimiterProperties.FailurePolicy.REJECT);
        for(String outcome:new String[]{"allowed","disabled","limited","unfulfillable","cancelled"}){
            var d=LimitDecision.local(outcome,"fixed","not_sent");assertSame(d,d.withPolicy(p));
            assertEquals(outcome.equals("allowed")||outcome.equals("disabled"),d.forwards());
        }
        assertEquals("cancel",LimitDecision.local("cancelled","client_cancelled","unknown").action());
    }
    @Test void startupBindingRejectsTyposAndNullInsteadOfSilentlyAllowing(){
        var bound=new Binder(new MapConfigurationPropertySource(Map.of("zenith.limiter.local-failure-policy","reject","zenith.limiter.redis-failure-policy","allow")))
                .bind("zenith.limiter",LimiterProperties.class).get();
        assertEquals(LimiterProperties.FailurePolicy.REJECT,bound.getLocalFailurePolicy());
        assertEquals(LimiterProperties.FailurePolicy.ALLOW,bound.getRedisFailurePolicy());
        for(String field:new String[]{"local","redis"}){
            assertThrows(Exception.class,()->new Binder(new MapConfigurationPropertySource(Map.of("zenith.limiter."+field+"-failure-policy","rejcet")))
                    .bind("zenith.limiter",LimiterProperties.class));
        }
        bound.setLocalFailurePolicy(null);assertThrows(IllegalArgumentException.class,bound::validate);
        bound=new LimiterProperties();bound.setRedisFailurePolicy(null);assertThrows(IllegalArgumentException.class,bound::validate);
    }
    @Test void productionLuaReplyRemainsCompatibleAndUnknownIsNotConvertedToNotSent(){
        var mapper=JsonMapper.builder().build();
        var reply=mapper.readValue("{\"outcome\":\"allowed\",\"reason\":\"quota_available\",\"execution\":\"confirmed\",\"staleRequest\":false}",LimitDecision.class);
        assertTrue(reply.forwards());assertNull(reply.rejectionSource());
        var p=new LimiterProperties();p.setRedisFailurePolicy(LimiterProperties.FailurePolicy.REJECT);
        var unknown=LimitDecision.local("redis_fail_open","decision_timeout","unknown").withPolicy(p);
        var json=mapper.readTree(mapper.writeValueAsString(unknown));
        assertEquals("reject",json.get("action").asText());assertEquals("redis_unconfirmed",json.get("event").asText());assertEquals("unknown",json.get("execution").asText());
    }
}
