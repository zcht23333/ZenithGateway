package com.zch.ratelimit;
import com.zch.config.RuntimeConfigSnapshot;
import reactor.core.publisher.Mono;
public interface RateLimitDecider { Mono<LimitDecision> decide(RuntimeConfigSnapshot snapshot,String clientIp); }
