package com.zch.config;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

class RuntimeConfigConcurrencyTest {
    static final String EPOCH = "11111111-1111-1111-1111-111111111111";
    static RuntimeConfigSnapshot snapshot(int revision) {
        boolean odd = revision % 2 == 1;
        return new RuntimeConfigSnapshot(EPOCH + ":" + revision,
                new RateLimitConfig(odd, odd ? 20 : 40, odd ? 30 : 60, odd ? 1 : 2),
                new MonitorConfig(odd ? 10 : 30, odd ? 1 : 3));
    }

    @Test void concurrentReadsContainOneWholeVersionIncludingBothGroups() throws Exception {
        var properties = new GatewayRuntimeProperties();
        properties.adopt(snapshot(1));
        var barrier = new CyclicBarrier(2);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var writer = executor.submit(() -> {
                for (int i = 2; i <= 2000; i++) {
                    barrier.await(3, java.util.concurrent.TimeUnit.SECONDS);
                    properties.adopt(snapshot(i));
                    barrier.await(3, java.util.concurrent.TimeUnit.SECONDS);
                }
                return true;
            });
            for (int i = 2; i <= 2000; i++) {
                barrier.await(3, java.util.concurrent.TimeUnit.SECONDS);
                var observed = properties.snapshot();
                assertTrue(observed.revision() == i || observed.revision() == i - 1);
                assertEquals(snapshot((int) observed.revision()), observed);
                barrier.await(3, java.util.concurrent.TimeUnit.SECONDS);
                assertEquals(snapshot(i), properties.snapshot());
            }
            assertTrue(writer.get(5, java.util.concurrent.TimeUnit.SECONDS));
        }
    }

    @Test void oldCompletionCannotRegressLocalAndEachPutKeepsItsOwnResponse() {
        var properties = new GatewayRuntimeProperties();
        properties.adopt(snapshot(1));
        var a = Sinks.<Map<?, ?>>one();
        var b = Sinks.<Map<?, ?>>one();
        var persistence = new RuntimeConfigPersistence(null, JsonMapper.builder().build(), properties) {
            @Override Mono<Map<?, ?>> operationCommand(String mode, String expected, String candidate, String id) {
                return expected.endsWith(":1") ? a.asMono() : b.asMono();
            }
        };
        var controller = new RuntimeConfigController(properties, persistence, new AdminAuthProperties());
        var requestA = snapshot(2).values(); requestA.put("expectedVersion", snapshot(1).version()); requestA.put("operationId","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        var requestB = snapshot(3).values(); requestB.put("expectedVersion", snapshot(2).version()); requestB.put("operationId","bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
        var futureA = controller.update(requestA).toFuture();
        var futureB = controller.update(requestB).toFuture();
        b.tryEmitValue(RuntimeConfigPersistenceTest.success(snapshot(3), "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"));
        assertEquals(snapshot(3).version(), futureB.join().getBody().get("version"));
        a.tryEmitValue(RuntimeConfigPersistenceTest.success(snapshot(2), "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
        var bodyA = futureA.join().getBody();
        assertEquals(snapshot(2).version(), bodyA.get("version"));
        assertEquals(30, bodyA.get("monitorWindowSeconds"));
        assertEquals(snapshot(3).response(), bodyA.get("adopted"));
        assertEquals(snapshot(3), properties.snapshot());
    }

    @Test void delayedReadKeepsItsSourceVersionAndReportsNewerLocalAdoption() {
        var properties = new GatewayRuntimeProperties();
        properties.adopt(snapshot(1));
        var pending = Sinks.<Map<?, ?>>one();
        var persistence = new RuntimeConfigPersistence(null, JsonMapper.builder().build(), properties) {
            @Override Mono<Map<?, ?>> command(String mode, String expected, RuntimeConfigSnapshot proposed) {
                return pending.asMono();
            }
        };
        var response = new RuntimeConfigController(properties, persistence, new AdminAuthProperties()).current().toFuture();
        properties.adopt(snapshot(3));
        pending.tryEmitValue(Map.of("status", "ok", "snapshot", snapshot(2).response()));
        assertEquals(snapshot(2).version(), response.join().getBody().get("version"));
        assertEquals(snapshot(3).response(), response.join().getBody().get("adopted"));
        assertEquals(snapshot(3), properties.snapshot());
    }

    @Test void generationsAndSameVersionWithDifferentValuesAreNeverSilentlyAdopted() {
        var properties = new GatewayRuntimeProperties();
        properties.adopt(snapshot(2));
        assertEquals(snapshot(2), properties.adopt(snapshot(1)));
        assertThrows(IllegalStateException.class, () -> properties.adopt(new RuntimeConfigSnapshot(
                "22222222-2222-2222-2222-222222222222:1", snapshot(1).rateLimit(), snapshot(1).monitor())));
        assertThrows(IllegalStateException.class, () -> properties.adopt(new RuntimeConfigSnapshot(
                snapshot(2).version(), snapshot(1).rateLimit(), snapshot(1).monitor())));
        assertThrows(IllegalStateException.class, () -> properties.setMonitor(MonitorConfig.defaults()));
        assertEquals(snapshot(2), properties.snapshot());
    }
}
