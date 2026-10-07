package com.zch.ratelimit;

import com.zch.config.MonitorConfig;
import com.zch.config.RateLimitConfig;
import com.zch.config.RuntimeConfigSnapshot;
import com.zch.config.RuntimeConfigSyncProperties;
import com.zch.monitor.RequestObservation;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.reactivestreams.Subscription;
import org.springframework.boot.data.redis.autoconfigure.DataRedisProperties;
import reactor.core.publisher.BaseSubscriber;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

class RedisRateLimiterLifecycleTest {
    @Test void cancellationBeforeCreateCallbackWinsEvenAnImmediateDisabledDecision() throws Exception {
        var limiter = new RedisRateLimiter(new DataRedisProperties(), new LimiterProperties(),
                new RuntimeConfigSyncProperties(), JsonMapper.builder().build());
        try {
            var snapshot = new RuntimeConfigSnapshot("11111111-1111-1111-1111-111111111111:1",
                    new RateLimitConfig(false,20,20,1), MonitorConfig.defaults());
            var observation = new RequestObservation();
            limiter.decide(snapshot,"127.0.0.1")
                    .contextWrite(c -> c.put(RequestObservation.CONTEXT_KEY,observation))
                    .subscribe(new BaseSubscriber<LimitDecision>() {
                        @Override protected void hookOnSubscribe(Subscription subscription) { cancel(); }
                        @Override protected void hookOnNext(LimitDecision decision) { fail("Cancelled subscription received a result"); }
                    });
            var state = limiter.status();
            var counters = (Map<?,?>) state.get("outcomes");
            assertEquals(1L,state.get("decisionsStarted"));
            assertEquals(1L,state.get("decisionsCompleted"));
            assertEquals(1L,counters.get("cancelled"));
            assertEquals(0L,counters.get("disabled"));
            assertEquals("cancelled",observation.rateLimitOutcome);
            assertEquals(0,state.get("connectionSlots"));
            assertEquals(state.get("admissionCapacity"),state.get("availableDecisionPermits"));
        } finally { limiter.destroy(); }
    }
}
