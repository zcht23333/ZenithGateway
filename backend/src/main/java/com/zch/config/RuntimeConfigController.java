package com.zch.config;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/settings")
public class RuntimeConfigController {
    private final GatewayRuntimeProperties properties;
    private final RuntimeConfigPersistence persistence;
    private final AdminAuthProperties authProperties;

    public RuntimeConfigController(GatewayRuntimeProperties properties, RuntimeConfigPersistence persistence,
                                   AdminAuthProperties authProperties) {
        this.properties = properties;
        this.persistence = persistence;
        this.authProperties = authProperties;
    }

    @GetMapping("/sse-token")
    public Mono<ResponseEntity<Map<String, Object>>> sseToken() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("token", authProperties.getSseToken());
        return Mono.just(response(200, payload));
    }

    /** Linearizes at Redis. A later concurrent adoption is explicitly represented separately. */
    @GetMapping("/runtime")
    public Mono<ResponseEntity<Map<String, Object>>> current() {
        return persistence.read().map(snapshot -> confirmed(snapshot, "read")).onErrorResume(ConfigProblem.class, this::problem);
    }

    /** Authenticated local diagnostics; never claims to confirm Redis state. */
    @GetMapping("/runtime/adopted")
    public Mono<ResponseEntity<Map<String, Object>>> adopted() {
        return Mono.fromSupplier(() -> {
            var body = properties.snapshot().response();
            body.put("source", "local");
            return response(200, body);
        });
    }

    @PutMapping("/runtime")
    public Mono<ResponseEntity<Map<String, Object>>> update(@RequestBody Map<String, Object> request) {
        return Mono.defer(() -> {
            if (!request.containsKey("expectedVersion"))
                throw new ConfigProblem(428, "CONFIG_VERSION_REQUIRED", "not-written",
                        "提交必须携带 expectedVersion；请先读取并核对完整配置");
            if (!(request.get("expectedVersion") instanceof String expected))
                throw ConfigProblem.validation("expectedVersion", "expectedVersion 必须是版本字符串");
            try { RuntimeConfigSnapshot.revision(expected); }
            catch (IllegalArgumentException error) { throw ConfigProblem.validation("expectedVersion", "版本格式非法"); }
            RuntimeConfigSnapshot proposed = RuntimeConfigSnapshot.from(request, expected);
            if (!request.containsKey("operationId"))
                throw new ConfigProblem(428, "CONFIG_OPERATION_REQUIRED", "not-written", "提交必须携带 operationId；请升级写入端");
            if (!(request.get("operationId") instanceof String operationId))
                throw ConfigProblem.validation("operationId", "operationId 必须是小写 UUID");
            return persistence.persist(operationId, expected, proposed).map(submission -> {
                var body = submission.snapshot().response();
                body.put("source", "redis"); body.put("confirmation", "committed");
                body.put("receipt", submission.receipt()); body.put("replayed", submission.replayed());
                body.put("adopted", properties.snapshot().response());
                return response(200, body);
            });
        }).onErrorResume(ConfigProblem.class, this::problem);
    }

    @GetMapping("/runtime/rollback-preview")
    public Mono<ResponseEntity<Map<String, Object>>> previewRollback(@RequestParam String sourceVersion,
                                                                    @RequestParam String sourceOperationId) {
        return Mono.defer(() -> persistence.previewRollback(new RuntimeConfigSource(sourceVersion, sourceOperationId)))
                .map(body -> {
                    body.put("origin", "redis-history"); body.put("adopted", properties.snapshot().response());
                    return response(200, body);
                }).onErrorResume(ConfigProblem.class, this::problem);
    }

    @PutMapping("/runtime/rollback")
    public Mono<ResponseEntity<Map<String, Object>>> rollback(@RequestBody Map<String, Object> request) {
        return Mono.defer(() -> {
            if (!request.containsKey("expectedVersion"))
                throw new ConfigProblem(428, "CONFIG_VERSION_REQUIRED", "not-written", "恢复必须携带核对时的 expectedVersion");
            if (!request.containsKey("operationId"))
                throw new ConfigProblem(428, "CONFIG_OPERATION_REQUIRED", "not-written", "恢复必须携带新的 operationId");
            if (!(request.get("expectedVersion") instanceof String expected))
                throw ConfigProblem.validation("expectedVersion", "expectedVersion 必须是版本字符串");
            try { RuntimeConfigSnapshot.revision(expected); }
            catch (IllegalArgumentException error) { throw ConfigProblem.validation("expectedVersion", "版本格式非法"); }
            if (!(request.get("operationId") instanceof String operationId))
                throw ConfigProblem.validation("operationId", "operationId 必须是小写 UUID");
            if (!request.keySet().equals(java.util.Set.of("expectedVersion", "operationId", "source")))
                throw ConfigProblem.validation("source", "恢复仅接受来源引用、expectedVersion 和 operationId；不能提交历史参数");
            var source = RuntimeConfigSource.from(request.get("source"));
            return persistence.rollback(operationId, expected, source).map(submission -> {
                var body = submission.snapshot().response();
                body.put("source", "redis"); body.put("confirmation", "committed");
                body.put("receipt", submission.receipt()); body.put("replayed", submission.replayed());
                body.put("adopted", properties.snapshot().response());
                return response(200, body);
            });
        }).onErrorResume(ConfigProblem.class, this::problem);
    }

    @GetMapping("/runtime/operations/{operationId}")
    public Mono<ResponseEntity<Map<String, Object>>> operation(@PathVariable String operationId) {
        return Mono.defer(() -> persistence.operation(operationId)).map(body -> {
            body.put("adopted", properties.snapshot().response()); return response(200, body);
        }).onErrorResume(ConfigProblem.class, this::problem);
    }

    @GetMapping("/runtime/history")
    public Mono<ResponseEntity<Map<String, Object>>> history(@RequestParam(defaultValue="") String cursor,
                                                           @RequestParam(defaultValue="20") int limit) {
        return Mono.defer(() -> persistence.history(cursor, limit)).map(body -> response(200, body))
                .onErrorResume(ConfigProblem.class, this::problem);
    }

    private ResponseEntity<Map<String, Object>> confirmed(RuntimeConfigSnapshot snapshot, String confirmation) {
        Map<String, Object> body = snapshot.response();
        body.put("source", "redis");
        body.put("confirmation", confirmation);
        body.put("adopted", properties.snapshot().response());
        return response(200, body);
    }

    private Mono<ResponseEntity<Map<String, Object>>> problem(ConfigProblem error) {
        Map<String, Object> body = error.response();
        body.put("adopted", properties.snapshot().response());
        return Mono.just(response(error.status(), body));
    }

    private ResponseEntity<Map<String, Object>> response(int status, Map<String, Object> body) {
        return ResponseEntity.status(status).cacheControl(CacheControl.noStore()).body(body);
    }
}
