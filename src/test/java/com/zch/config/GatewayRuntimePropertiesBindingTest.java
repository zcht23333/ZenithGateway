package com.zch.config;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.BindResult;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

/**
 * 验证 application.yml 中的 zenith.rate-limit.* 和 zenith.monitor.* 配置
 * 能够正确绑定到嵌套的 Java Record 类型上。
 *
 * 核心关注：Spring Boot 3.2 的嵌套 record 绑定不会静默失败。
 */
class GatewayRuntimePropertiesBindingTest {

    @Test
    void shouldBindRateLimitConfigFromYamlStyleProperties() {
        Map<String, String> props = new LinkedHashMap<>();
        // 模拟 application.yml 中的值（刻意使用与默认值不同的值以验证绑定生效）
        props.put("zenith.rate-limit.enabled", "false");
        props.put("zenith.rate-limit.replenish-rate", "100");
        props.put("zenith.rate-limit.burst-capacity", "200");
        props.put("zenith.rate-limit.requested-tokens", "3");

        GatewayRuntimeProperties properties = bind(props);

        RateLimitConfig rateLimit = properties.getRateLimit();
        Assertions.assertFalse(rateLimit.enabled(), "yml value should override default");
        Assertions.assertEquals(100, rateLimit.replenishRate(), "replenish-rate should bind to replenishRate");
        Assertions.assertEquals(200, rateLimit.burstCapacity(), "burst-capacity should bind to burstCapacity");
        Assertions.assertEquals(3, rateLimit.requestedTokens(), "requested-tokens should bind to requestedTokens");
    }

    @Test
    void shouldBindMonitorConfigFromYamlStyleProperties() {
        Map<String, String> props = new LinkedHashMap<>();
        props.put("zenith.monitor.window-seconds", "30");
        props.put("zenith.monitor.emit-interval-seconds", "2");

        GatewayRuntimeProperties properties = bind(props);

        MonitorConfig monitor = properties.getMonitor();
        Assertions.assertEquals(30, monitor.windowSeconds(), "window-seconds should bind to windowSeconds");
        Assertions.assertEquals(2, monitor.emitIntervalSeconds(), "emit-interval-seconds should bind to emitIntervalSeconds");
    }

    @Test
    void shouldKeepDefaultsWhenYamlKeyAbsent() {
        Map<String, String> props = new LinkedHashMap<>();
        // 不设置任何 zenith.rate-limit 属性

        GatewayRuntimeProperties properties = bind(props);

        RateLimitConfig rateLimit = properties.getRateLimit();
        Assertions.assertTrue(rateLimit.enabled(), "default when no yml key");
        Assertions.assertEquals(20, rateLimit.replenishRate(), "default when no yml key");
    }

    @Test
    void shouldBindAuditAndRouteConfig() {
        Map<String, String> props = new LinkedHashMap<>();
        props.put("zenith.audit.buffer-size", "30000");
        props.put("zenith.route.redis-key", "custom:routes");

        GatewayRuntimeProperties properties = bind(props);

        Assertions.assertEquals(30000, properties.getAudit().getBufferSize());
        Assertions.assertEquals("custom:routes", properties.getRoute().getRedisKey());
    }

    private static GatewayRuntimeProperties bind(Map<String, String> props) {
        GatewayRuntimeProperties target = new GatewayRuntimeProperties();
        Binder binder = new Binder(new MapConfigurationPropertySource(props));
        BindResult<GatewayRuntimeProperties> result = binder.bind("zenith", GatewayRuntimeProperties.class);
        result.ifBound(t -> {
            // 将绑定结果拷贝到 target
            if (t.getRateLimit() != null) target.setRateLimit(t.getRateLimit());
            if (t.getMonitor() != null) target.setMonitor(t.getMonitor());
            if (t.getAudit().getBufferSize() != 20000) target.getAudit().setBufferSize(t.getAudit().getBufferSize());
            if (!"zg:routes".equals(t.getRoute().getRedisKey())) target.getRoute().setRedisKey(t.getRoute().getRedisKey());
        });
        return target;
    }
}
