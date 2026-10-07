package com.zch.route;
import org.springframework.boot.context.properties.ConfigurationProperties;
@ConfigurationProperties("zenith.route.publication")
public class RoutePublicationProperties {
    private long intervalMs=1000,timeoutMs=750,staleAfterMs=5000;
    public long getIntervalMs(){return intervalMs;} public void setIntervalMs(long v){intervalMs=v;}
    public long getTimeoutMs(){return timeoutMs;} public void setTimeoutMs(long v){timeoutMs=v;}
    public long getStaleAfterMs(){return staleAfterMs;} public void setStaleAfterMs(long v){staleAfterMs=v;}
    public void validate(){if(intervalMs<100||intervalMs>60000||timeoutMs<100||timeoutMs>5000||staleAfterMs<intervalMs+timeoutMs||staleAfterMs>600000)throw new IllegalArgumentException("Invalid route publication interval, timeout or freshness budget");}
}
