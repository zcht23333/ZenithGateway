package com.zch.config;

import java.util.Map;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static com.zch.config.RuntimeConfigConcurrencyTest.snapshot;

class RuntimeConfigOperationsTest {
    private static final String ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    private final GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
    private Mono<Map<?, ?>> reply = Mono.empty();
    private int commands;
    private final RuntimeConfigPersistence persistence = new RuntimeConfigPersistence(null, JsonMapper.builder().build(), properties) {
        @Override Mono<Map<?, ?>> operationCommand(String mode, String expected, String candidate, String id) {
            commands++; return reply;
        }
    };
    private final RuntimeConfigController controller = new RuntimeConfigController(properties, persistence, new AdminAuthProperties());

    @Test void missingAndMalformedIdentityFailBeforeAnyStorageCommand() {
        var request = snapshot(2).values(); request.put("expectedVersion", snapshot(1).version());
        var missing = controller.update(request).block();
        assertEquals(428, missing.getStatusCode().value());
        assertEquals("CONFIG_OPERATION_REQUIRED", missing.getBody().get("code"));
        request.put("operationId", "not-a-uuid");
        assertEquals(400, controller.update(request).block().getStatusCode().value());
        assertEquals(0, commands);
    }
    @Test void replayReturnsItsOriginalReceiptButCannotRegressAdoptedConfiguration() {
        properties.adopt(snapshot(5));
        var r = new java.util.LinkedHashMap<String, Object>();
        RuntimeConfigPersistenceTest.success(snapshot(2), ID).forEach((k,v)->r.put(k.toString(),v));
        r.put("replayed", true); reply = Mono.just(r);
        var request = snapshot(2).values(); request.put("operationId", ID); request.put("expectedVersion", snapshot(1).version());
        var response = controller.update(request).block();
        assertEquals(200, response.getStatusCode().value());
        assertEquals(snapshot(2).version(), response.getBody().get("version"));
        assertEquals(snapshot(5).response(), response.getBody().get("adopted"));
        assertEquals(true, response.getBody().get("replayed"));
        assertEquals(snapshot(5), properties.snapshot());
        assertEquals("no-store", response.getHeaders().getCacheControl());
    }
    @Test void receiptQueryDoesNotPublishHistoricalValuesOrClaimClusterAdoption() {
        properties.adopt(snapshot(5));
        var receipt = RuntimeConfigPersistenceTest.success(snapshot(2), ID).get("receipt");
        reply = Mono.just(Map.of("status", "committed", "receipt", receipt));
        var response = controller.operation(ID).block();
        assertEquals("committed", response.getBody().get("status"));
        assertEquals("redis-receipt", response.getBody().get("source"));
        assertEquals(snapshot(5), properties.snapshot());
        assertEquals("no-store", response.getHeaders().getCacheControl());
    }
    @Test void missingReceiptAndReadFailureBothStayUnknownWithoutNegativeAttribution() {
        properties.adopt(snapshot(5));
        reply = Mono.just(Map.of("status", "unknown", "reason", "no-available-receipt"));
        var absent = controller.operation(ID).block();
        assertEquals(200, absent.getStatusCode().value());
        assertEquals("unknown", absent.getBody().get("status"));
        reply = Mono.error(new IllegalStateException("Redis unavailable"));
        var unavailable = controller.operation(ID).block();
        assertEquals(503, unavailable.getStatusCode().value());
        assertEquals("unknown", unavailable.getBody().get("outcome"));
        assertEquals("unknown", unavailable.getBody().get("status"));
        assertEquals(snapshot(5), properties.snapshot());
    }
    @Test void mismatchedAcknowledgementDoesNotInventSuccess() {
        properties.adopt(snapshot(1));
        reply = Mono.just(RuntimeConfigPersistenceTest.success(snapshot(2), "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"));
        var error = assertThrows(ConfigProblem.class, () -> persistence.persist(ID, snapshot(1).version(), snapshot(2)).block());
        assertEquals("unknown", error.response().get("outcome"));
        assertEquals(ID, error.response().get("operationId"));
        assertEquals(snapshot(1), properties.snapshot());
    }
    @Test void historyPaginationRejectsInvalidLimitsAndEpochsAndNeverAdopts() {
        properties.adopt(snapshot(5));
        assertEquals(400, controller.history("", 51).block().getStatusCode().value());
        assertEquals(400, controller.history("broken", 10).block().getStatusCode().value());
        assertEquals(0, commands);
        reply = Mono.just(Map.of("status", "cursor-invalid"));
        assertEquals(409, controller.history(snapshot(1).version(), 10).block().getStatusCode().value());
        reply = Mono.just(Map.of("status","ok","entries",Map.of()));
        var result = controller.history("", 20).block();
        assertEquals(java.util.List.of(), result.getBody().get("entries"));
        assertEquals("no-store", result.getHeaders().getCacheControl());
        assertEquals(snapshot(5), properties.snapshot());
    }
}
