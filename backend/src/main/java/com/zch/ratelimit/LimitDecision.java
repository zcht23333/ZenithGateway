package com.zch.ratelimit;

import com.fasterxml.jackson.annotation.JsonProperty;

/** The quota fact, policy action and final HTTP outcome are independent. */
public record LimitDecision(String outcome,String reason,String execution,Long retryAfterSeconds,
        String version,Long tokensMilli,Long serverTimeMs,Long billedTimeMs,Long expiresAtMs,
        Integer capacity,Integer rate,Integer cost,boolean staleRequest,String rejectionSource) {
    public LimitDecision(String outcome,String reason,String execution,Long retryAfterSeconds,
            String version,Long tokensMilli,Long serverTimeMs,Long billedTimeMs,Long expiresAtMs,
            Integer capacity,Integer rate,Integer cost,boolean staleRequest) {
        this(outcome,reason,execution,retryAfterSeconds,version,tokensMilli,serverTimeMs,billedTimeMs,expiresAtMs,
                capacity,rate,cost,staleRequest,null);
    }
    public boolean forwards(){return action().equals("forward");}
    @JsonProperty(access=JsonProperty.Access.READ_ONLY)
    public String event(){
        return switch(outcome){
            case "local_fail_open","local_rejected" -> "local_unavailable";
            case "redis_fail_open","redis_rejected" -> "redis_unconfirmed";
            default -> outcome;
        };
    }
    @JsonProperty(access=JsonProperty.Access.READ_ONLY)
    public String action(){
        return switch(outcome){
            case "allowed","disabled","local_fail_open","redis_fail_open" -> "forward";
            case "cancelled" -> "cancel";
            default -> "reject";
        };
    }
    public LimitDecision withPolicy(LimiterProperties policy){
        String chosen=outcome;
        if(outcome.equals("local_fail_open")&&policy.getLocalFailurePolicy()==LimiterProperties.FailurePolicy.REJECT)chosen="local_rejected";
        if(outcome.equals("redis_fail_open")&&policy.getRedisFailurePolicy()==LimiterProperties.FailurePolicy.REJECT)chosen="redis_rejected";
        return chosen.equals(outcome)?this:new LimitDecision(chosen,reason,execution,retryAfterSeconds,version,tokensMilli,
                serverTimeMs,billedTimeMs,expiresAtMs,capacity,rate,cost,staleRequest,rejectionSource);
    }
    public static LimitDecision local(String outcome,String reason,String execution){
        return local(outcome,reason,execution,null);
    }
    public static LimitDecision local(String outcome,String reason,String execution,String rejectionSource){
        return new LimitDecision(outcome,reason,execution,null,null,null,null,null,null,null,null,null,false,rejectionSource);
    }
}
