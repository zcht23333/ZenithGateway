package com.zch.config;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static com.zch.config.RuntimeConfigConcurrencyTest.snapshot;

class RuntimeConfigRollbackTest {
    private static final String ID="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", SOURCE="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    private final GatewayRuntimeProperties properties=new GatewayRuntimeProperties();
    private Mono<Map<?, ?>> reply=Mono.empty();
    private int calls;
    private String mode,expected,candidate;
    private final RuntimeConfigPersistence persistence=new RuntimeConfigPersistence(null,JsonMapper.builder().build(),properties) {
        @Override Mono<Map<?, ?>> operationCommand(String m,String e,String c,String id) { calls++;mode=m;expected=e;candidate=c;return reply; }
    };
    private final RuntimeConfigController controller=new RuntimeConfigController(properties,persistence,new AdminAuthProperties());
    private Map<String,Object> source() {return Map.of("version",snapshot(2).version(),"operationId",SOURCE);}
    private Map<String,Object> request() {return new LinkedHashMap<>(Map.of("expectedVersion",snapshot(5).version(),"operationId",ID,"source",source()));}
    private Map<String,Object> success() {
        var receipt=new LinkedHashMap<String,Object>();
        receipt.put("operationType","rollback");receipt.put("operationId",ID);receipt.put("expectedVersion",snapshot(5).version());
        receipt.put("status","committed");receipt.put("source",source());receipt.put("after",snapshot(6).response());
        receipt.put("recordedAt",1);receipt.put("expiresAt",86400001);
        return new LinkedHashMap<>(Map.of("status","ok","snapshot",snapshot(6).response(),"receipt",receipt,"replayed",true));
    }
    @Test void onlyAnExactValidatedReferenceIsAcceptedNotClientHistoricalValues() {
        for(var key:java.util.List.of("expectedVersion","operationId")) {
            var r=request();r.remove(key);assertEquals(428,controller.rollback(r).block().getStatusCode().value());
        }
        var extra=request();extra.put("replenishRate",999);assertEquals(400,controller.rollback(extra).block().getStatusCode().value());
        for(Object source:java.util.List.of(Map.of("version","broken","operationId",SOURCE),Map.of("version",snapshot(2).version(),"operationId",SOURCE,"replenishRate",99))) {
            var r=request();r.put("source",source);assertEquals(400,controller.rollback(r).block().getStatusCode().value());
        }
        assertEquals(0,calls);
    }
    @Test void previewPairsAuthorityCurrentAndHistoryWithoutPublishingTheHistoricalSnapshot() {
        properties.adopt(snapshot(5));
        reply=Mono.just(Map.of("status","ok","current",snapshot(5).response(),"target",snapshot(2).response(),"source",source()));
        var response=controller.previewRollback(snapshot(2).version(),SOURCE).block();
        assertEquals(200,response.getStatusCode().value());assertEquals("no-store",response.getHeaders().getCacheControl());
        assertEquals(snapshot(2).response(),response.getBody().get("target"));assertEquals(snapshot(5),properties.snapshot());
        assertEquals("rollback-preview",mode);
    }
    @Test void confirmedRollbackReturnsItsExactReceiptAndCannotRegressLocalAdoption() {
        properties.adopt(snapshot(8));reply=Mono.just(success());
        var response=controller.rollback(request()).block();
        assertEquals(200,response.getStatusCode().value());assertEquals(snapshot(6).version(),response.getBody().get("version"));
        assertEquals(snapshot(8).response(),response.getBody().get("adopted"));assertEquals(snapshot(8),properties.snapshot());
        assertEquals("rollback",mode);assertEquals(snapshot(5).version(),expected);
        assertFalse(candidate.contains("replenishRate"));assertEquals("no-store",response.getHeaders().getCacheControl());
    }
    @Test void vanishedHistoryIsDefiniteForThisAttemptWhileTransportLossRemainsUnknown() {
        properties.adopt(snapshot(5));reply=Mono.just(Map.of("status","history-unavailable"));
        var gone=controller.rollback(request()).block();
        assertEquals(410,gone.getStatusCode().value());assertEquals("not-written",gone.getBody().get("outcome"));
        reply=Mono.error(new IllegalStateException("reply lost"));
        var unknown=controller.rollback(request()).block();
        assertEquals(503,unknown.getStatusCode().value());assertEquals("unknown",unknown.getBody().get("outcome"));
        assertEquals(ID,unknown.getBody().get("operationId"));assertEquals(snapshot(5),properties.snapshot());
    }
    @Test void sourceOrTypeMismatchInAcknowledgementIsNeverInventedAsSuccess() {
        properties.adopt(snapshot(5));
        for(String field:java.util.List.of("source","operationType")) {
            var response=success();var receipt=new LinkedHashMap<>((Map<String,Object>)response.get("receipt"));
            receipt.put(field,field.equals("source")?Map.of("version",snapshot(3).version(),"operationId",SOURCE):"update");
            response.put("receipt",receipt);reply=Mono.just(response);
            assertEquals("unknown",controller.rollback(request()).block().getBody().get("outcome"));
            assertEquals(snapshot(5),properties.snapshot());
        }
    }
    @Test void versionConflictAndCapacityRemainDefiniteAndDoNotGenerateAnApplicationRetry() {
        properties.adopt(snapshot(5));reply=Mono.just(Map.of("status","conflict","snapshot",snapshot(6).response()));
        var conflict=controller.rollback(request()).block();assertEquals(409,conflict.getStatusCode().value());
        assertEquals(snapshot(6).response(),conflict.getBody().get("current"));assertEquals(1,calls);
        reply=Mono.just(Map.of("status","receipt-capacity"));assertEquals(429,controller.rollback(request()).block().getStatusCode().value());
        assertEquals(2,calls);assertEquals(snapshot(6),properties.snapshot());
    }
}
