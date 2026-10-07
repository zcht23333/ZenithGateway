package com.zch.proxy;

import jakarta.annotation.PostConstruct;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Startup-only policy. Deliberately independent of the six-field runtime protocol. */
@ConfigurationProperties("zenith.proxy.resilience")
public class ProxyPolicy {
    private int connectTimeoutMs=1000, headersTimeoutMs=2000, readIdleTimeoutMs=3000, totalTimeoutMs=5000;
    private int maxConnections=100, maxPendingAcquires=100, acquireTimeoutMs=500;
    private int slidingWindowSize=20, minimumCalls=10, failureRateThreshold=50, openWaitMs=10000, halfOpenCalls=2;
    public int getConnectTimeoutMs(){return connectTimeoutMs;} public void setConnectTimeoutMs(int v){connectTimeoutMs=v;}
    public int getHeadersTimeoutMs(){return headersTimeoutMs;} public void setHeadersTimeoutMs(int v){headersTimeoutMs=v;}
    public int getReadIdleTimeoutMs(){return readIdleTimeoutMs;} public void setReadIdleTimeoutMs(int v){readIdleTimeoutMs=v;}
    public int getTotalTimeoutMs(){return totalTimeoutMs;} public void setTotalTimeoutMs(int v){totalTimeoutMs=v;}
    public int getMaxConnections(){return maxConnections;} public void setMaxConnections(int v){maxConnections=v;}
    public int getMaxPendingAcquires(){return maxPendingAcquires;} public void setMaxPendingAcquires(int v){maxPendingAcquires=v;}
    public int getAcquireTimeoutMs(){return acquireTimeoutMs;} public void setAcquireTimeoutMs(int v){acquireTimeoutMs=v;}
    public int getSlidingWindowSize(){return slidingWindowSize;} public void setSlidingWindowSize(int v){slidingWindowSize=v;}
    public int getMinimumCalls(){return minimumCalls;} public void setMinimumCalls(int v){minimumCalls=v;}
    public int getFailureRateThreshold(){return failureRateThreshold;} public void setFailureRateThreshold(int v){failureRateThreshold=v;}
    public int getOpenWaitMs(){return openWaitMs;} public void setOpenWaitMs(int v){openWaitMs=v;}
    public int getHalfOpenCalls(){return halfOpenCalls;} public void setHalfOpenCalls(int v){halfOpenCalls=v;}
    @PostConstruct public void validate(){
        if(connectTimeoutMs<50 || connectTimeoutMs>10000 || headersTimeoutMs<connectTimeoutMs || headersTimeoutMs>30000
                || readIdleTimeoutMs<headersTimeoutMs || readIdleTimeoutMs>60000 || totalTimeoutMs<=readIdleTimeoutMs || totalTimeoutMs>120000
                || acquireTimeoutMs<50 || acquireTimeoutMs>headersTimeoutMs || maxConnections<1 || maxConnections>1000
                || maxPendingAcquires<1 || maxPendingAcquires>1000 || slidingWindowSize<2 || slidingWindowSize>1000
                || minimumCalls<2 || minimumCalls>slidingWindowSize || failureRateThreshold<1 || failureRateThreshold>100
                || openWaitMs<100 || openWaitMs>300000 || halfOpenCalls<1 || halfOpenCalls>100)
            throw new IllegalArgumentException("Invalid zenith.proxy.resilience policy: 50ms <= connect <= headers <= read-idle < total <= 120s; bounded pool and breaker required");
    }
    public Map<String,Object> values(){
        var v=new LinkedHashMap<String,Object>();
        v.put("connectTimeoutMs",connectTimeoutMs);v.put("tlsHandshakeTimeoutMs",connectTimeoutMs);v.put("headersTimeoutMs",headersTimeoutMs);v.put("readIdleTimeoutMs",readIdleTimeoutMs);v.put("totalTimeoutMs",totalTimeoutMs);
        v.put("maxConnectionsPerOrigin",maxConnections);v.put("maxPendingAcquiresPerOrigin",maxPendingAcquires);v.put("acquireTimeoutMs",acquireTimeoutMs);
        v.put("slidingWindowSize",slidingWindowSize);v.put("minimumCalls",minimumCalls);v.put("failureRateThreshold",failureRateThreshold);v.put("openWaitMs",openWaitMs);v.put("halfOpenCalls",halfOpenCalls);
        v.put("automaticRetry",false);v.put("followRedirects",false);v.put("failureStatuses","500..599; response preserved");return v;
    }
}
