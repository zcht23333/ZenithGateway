package com.zch.config;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static com.zch.config.RuntimeConfigConcurrencyTest.snapshot;

class RuntimeConfigPersistenceTest {
    static Map<?, ?> success(RuntimeConfigSnapshot after, String id) {
        return Map.of("status","ok","snapshot",after.response(),"receipt",Map.of(
            "operationId",id,"expectedVersion",after.epoch()+":"+(after.revision()-1),
            "status","committed","after",after.response(),"recordedAt",1,"expiresAt",86400001));
    }
    private final GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
    private Mono<Map<?, ?>> reply = Mono.empty();
    private final RuntimeConfigPersistence persistence =
            new RuntimeConfigPersistence(null, JsonMapper.builder().build(), properties) {
                @Override Mono<Map<?, ?>> command(String mode, String expected, RuntimeConfigSnapshot proposed) { return reply; }
                @Override Mono<Map<?, ?>> operationCommand(String mode, String expected, String candidate, String id) { return reply; }
            };
    private final RuntimeConfigController controller = new RuntimeConfigController(properties, persistence, new AdminAuthProperties());

    @Test void startupWaitsForConfirmedSnapshotThenPublishesOneVersion() throws Exception {
        var entered = new CountDownLatch(1);
        var pending = Sinks.<Map<?, ?>>one();
        reply = pending.asMono().doOnSubscribe(ignored -> entered.countDown());
        try (var executor = Executors.newSingleThreadExecutor()) {
            var startup = executor.submit(() -> persistence.run(new DefaultApplicationArguments()));
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            assertFalse(startup.isDone());
            assertNull(properties.snapshot().version());
            pending.tryEmitValue(Map.of("status", "ok", "snapshot", snapshot(2).response()));
            startup.get(2, TimeUnit.SECONDS);
            assertEquals(snapshot(2), properties.snapshot());
        }
    }

    @Test void startupRefusesUnavailableMalformedAndMissingAcknowledgements() {
        for (Mono<Map<?, ?>> failure : java.util.List.<Mono<Map<?, ?>>>of(
                Mono.error(new IllegalStateException("offline")), Mono.just(Map.of("status", "invalid")),
                Mono.just(Map.of("status", "ok", "snapshot", Map.of())))) {
            reply = failure;
            assertThrows(IllegalStateException.class, () -> persistence.run(new DefaultApplicationArguments()));
            assertNull(properties.snapshot().version());
        }
    }

    @Test void startupHasAFiniteDeadline() {
        reply = Mono.never();
        assertTimeoutPreemptively(Duration.ofSeconds(7),
                () -> assertThrows(IllegalStateException.class, () -> persistence.run(new DefaultApplicationArguments())));
    }

    @Test void missingVersionAndInvalidFieldsAreRejectedBeforeStorage() {
        assertEquals(428, controller.update(snapshot(2).values()).block().getStatusCode().value());
        var request = snapshot(2).values();
        request.put("expectedVersion", snapshot(1).version()); request.put("replenishRate", 1.5);
        var response = controller.update(request).block();
        assertEquals(400, response.getStatusCode().value());
        assertEquals("not-written", response.getBody().get("outcome"));
        assertEquals("replenishRate", response.getBody().get("field"));
        request.put("replenishRate", 20); request.remove("emitIntervalSeconds");
        assertEquals(400, controller.update(request).block().getStatusCode().value());
    }

    @Test void knownRejectionDoesNotPublishAndConflictIncludesExactCurrentSnapshot() {
        properties.adopt(snapshot(1));
        reply = Mono.just(Map.of("status", "rejected"));
        var rejected = assertThrows(ConfigProblem.class, () -> persistence.persist("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", snapshot(1).version(), snapshot(2)).block());
        assertEquals("not-written", rejected.response().get("outcome"));
        assertEquals(snapshot(1), properties.snapshot());
        reply = Mono.just(Map.of("status", "conflict", "snapshot", snapshot(2).response()));
        var conflict = assertThrows(ConfigProblem.class, () -> persistence.persist("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", snapshot(1).version(), snapshot(3)).block());
        assertEquals(409, conflict.status());
        assertEquals(snapshot(2).response(), conflict.response().get("current"));
        assertEquals(snapshot(2), properties.snapshot());
    }

    @Test void unacknowledgedWriteIsUnknownUntilStorageReadAndReadFailureCannotConfirm() {
        properties.adopt(snapshot(1));
        reply = Mono.error(new IllegalStateException("reply lost"));
        var error = assertThrows(ConfigProblem.class, () -> persistence.persist("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", snapshot(1).version(), snapshot(2)).block());
        assertEquals("unknown", error.response().get("outcome"));
        assertEquals(snapshot(1), properties.snapshot());
        var readFailure = controller.current().block();
        assertEquals(503, readFailure.getStatusCode().value());
        assertEquals("CONFIG_READ_UNAVAILABLE", readFailure.getBody().get("code"));
        assertEquals(snapshot(1).response(), readFailure.getBody().get("adopted"));
        // Another writer can already have committed revision 3. The read does not attribute revision 2.
        reply = Mono.just(Map.of("status", "ok", "snapshot", snapshot(3).response()));
        var read = controller.current().block().getBody();
        assertEquals("read", read.get("confirmation"));
        assertEquals("redis", read.get("source"));
        assertEquals(snapshot(3).version(), read.get("version"));
        assertEquals(snapshot(3), properties.snapshot());
        assertEquals("local", controller.adopted().block().getBody().get("source"));
    }

    @Test void acknowledgedCommitWithAdoptionFailureStillReportsCommittedNotUnknown() {
        properties.adopt(snapshot(1));
        var foreign = new RuntimeConfigSnapshot("22222222-2222-2222-2222-222222222222:2",
                snapshot(2).rateLimit(), snapshot(2).monitor());
        reply = Mono.just(success(foreign, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
        var error = assertThrows(ConfigProblem.class, () -> persistence.persist("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", foreign.epoch()+":1", foreign).block());
        assertEquals("committed", error.response().get("outcome"));
        assertEquals(foreign.response(), error.response().get("confirmed"));
        assertEquals(snapshot(1), properties.snapshot());
    }
}
