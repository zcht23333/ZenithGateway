package com.zch.config;

import java.util.concurrent.atomic.AtomicReference;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "zenith")
public class GatewayRuntimeProperties {

    /**
     * 限流配置 —— 运行时可通过 API 修改，使用 AtomicReference 保证跨线程可见性。
     */
    private final AtomicReference<RateLimitConfig> rateLimitRef =
            new AtomicReference<>(RateLimitConfig.defaults());

    /**
     * 监控配置 —— 运行时可通过 API 修改。
     */
    private final AtomicReference<MonitorConfig> monitorRef =
            new AtomicReference<>(MonitorConfig.defaults());

    /** 只读配置：审计日志（启动后不变） */
    private final Audit audit = new Audit();

    /** 只读配置：路由存储（启动后不变） */
    private final Route route = new Route();

    // ─── Spring Boot 配置绑定入口 ───

    public RateLimitConfig getRateLimit() {
        return rateLimitRef.get();
    }

    public void setRateLimit(RateLimitConfig rateLimit) {
        this.rateLimitRef.set(rateLimit);
    }

    public MonitorConfig getMonitor() {
        return monitorRef.get();
    }

    public void setMonitor(MonitorConfig monitor) {
        this.monitorRef.set(monitor);
    }

    // ─── 运行时安全更新 API ───

    public RateLimitConfig updateRateLimit(RateLimitConfig next) {
        return rateLimitRef.updateAndGet(current -> next);
    }

    public MonitorConfig updateMonitor(MonitorConfig next) {
        return monitorRef.updateAndGet(current -> next);
    }

    // ─── 只读配置（不变） ───

    public Audit getAudit() {
        return audit;
    }

    public Route getRoute() {
        return route;
    }

    // ─── 内部配置类 ───

    public static class Audit {
        private int bufferSize = 20000;
        private String redisKey = "zg:audit:events";
        private int redisMaxEntries = 5000;

        public int getBufferSize() {
            return bufferSize;
        }

        public void setBufferSize(int bufferSize) {
            this.bufferSize = bufferSize;
        }

        public String getRedisKey() {
            return redisKey;
        }

        public void setRedisKey(String redisKey) {
            this.redisKey = redisKey;
        }

        public int getRedisMaxEntries() {
            return redisMaxEntries;
        }

        public void setRedisMaxEntries(int redisMaxEntries) {
            this.redisMaxEntries = redisMaxEntries;
        }
    }

    public static class Route {
        private String redisKey = "zg:routes";

        public String getRedisKey() {
            return redisKey;
        }

        public void setRedisKey(String redisKey) {
            this.redisKey = redisKey;
        }
    }
}
