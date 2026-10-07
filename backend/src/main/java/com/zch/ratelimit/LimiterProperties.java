package com.zch.ratelimit;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Startup-only resource limits; the existing six-field runtime protocol is unchanged. */
@ConfigurationProperties("zenith.limiter")
public class LimiterProperties {
    public enum FailurePolicy { ALLOW, REJECT }
    private FailurePolicy localFailurePolicy=FailurePolicy.ALLOW,redisFailurePolicy=FailurePolicy.ALLOW;
    public FailurePolicy getLocalFailurePolicy(){return localFailurePolicy;}
    public void setLocalFailurePolicy(FailurePolicy v){localFailurePolicy=v;}
    public FailurePolicy getRedisFailurePolicy(){return redisFailurePolicy;}
    public void setRedisFailurePolicy(FailurePolicy v){redisFailurePolicy=v;}
    private String namespace="zg:rl:v2";
    private int workers=8,queueCapacity=64,resultWorkers=2;
    private boolean resultHandoffEnabled=false,saturationSamplingEnabled=false;
    private long decisionTimeoutMs=500,probeIntervalMs=1000;
    public String getNamespace(){return namespace;} public void setNamespace(String v){namespace=v;}
    public int getWorkers(){return workers;} public void setWorkers(int v){workers=v;}
    public int getQueueCapacity(){return queueCapacity;} public void setQueueCapacity(int v){queueCapacity=v;}
    public long getDecisionTimeoutMs(){return decisionTimeoutMs;} public void setDecisionTimeoutMs(long v){decisionTimeoutMs=v;}
    public long getProbeIntervalMs(){return probeIntervalMs;} public void setProbeIntervalMs(long v){probeIntervalMs=v;}
    public int getResultWorkers(){return resultWorkers;} public void setResultWorkers(int v){resultWorkers=v;}
    public boolean isResultHandoffEnabled(){return resultHandoffEnabled;} public void setResultHandoffEnabled(boolean v){resultHandoffEnabled=v;}
    public boolean isSaturationSamplingEnabled(){return saturationSamplingEnabled;} public void setSaturationSamplingEnabled(boolean v){saturationSamplingEnabled=v;}
    public void validate(){
        if(localFailurePolicy==null||redisFailurePolicy==null||namespace==null||!namespace.matches("[a-zA-Z0-9:_-]{1,128}")||workers<1||workers>64||queueCapacity<0||queueCapacity>4096
                ||resultWorkers<1||resultWorkers>16||decisionTimeoutMs<50||decisionTimeoutMs>2000||probeIntervalMs<100||probeIntervalMs>30000)
            throw new IllegalArgumentException("Invalid zenith.limiter namespace or resource limits");
    }
}
