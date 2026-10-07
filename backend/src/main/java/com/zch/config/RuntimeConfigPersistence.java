package com.zch.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import tools.jackson.databind.json.JsonMapper;

/** Storage confirmation is separate from monotonic local adoption. Never used by proxy requests. */
@Service
public class RuntimeConfigPersistence implements ApplicationRunner {
    private static final DefaultRedisScript<String> SCRIPT = script();
    private static DefaultRedisScript<String> script() {
        var script = new DefaultRedisScript<String>();
        script.setLocation(new ClassPathResource("runtime-config.lua"));
        script.setResultType(String.class);
        return script;
    }
    @Value("${zenith.runtime.redis-key:zg:runtime:config}")
    private String redisKey = "zg:runtime:config";
    private final ReactiveStringRedisTemplate redis;
    private final JsonMapper mapper;
    private final GatewayRuntimeProperties properties;
    private final String instanceId;

    @Autowired
    public RuntimeConfigPersistence(ReactiveStringRedisTemplate redis, JsonMapper mapper,
                                    GatewayRuntimeProperties properties, RuntimeConfigSyncProperties sync) {
        this.redis = redis; this.mapper = mapper; this.properties = properties;
        this.instanceId = sync.getInstanceId();
    }
    public RuntimeConfigPersistence(ReactiveStringRedisTemplate redis, JsonMapper mapper, GatewayRuntimeProperties properties) {
        this(redis, mapper, properties, new RuntimeConfigSyncProperties());
    }

    public record Submission(RuntimeConfigSnapshot snapshot, Map<String, Object> receipt, boolean replayed) {}

    @Override public void run(ApplicationArguments args) {
        try {
            java.util.Objects.requireNonNull(command("init", UUID.randomUUID() + ":1", properties.snapshot())
                    .map(reply -> confirmed(reply, "init", null))
                    .doOnNext(properties::adopt)
                    .block(Duration.ofSeconds(5)), "Missing startup acknowledgement");
        } catch (Exception error) {
            throw new IllegalStateException("Unable to restore runtime configuration; refusing startup", error);
        }
    }

    public Mono<RuntimeConfigSnapshot> read() {
        return command("read", "", null).map(reply -> confirmed(reply, "read", null))
                .doOnNext(snapshot -> adopt(snapshot, false)).onErrorMap(error -> transport(error, false));
    }

    public Mono<Submission> persist(String operationId, String expectedVersion, RuntimeConfigSnapshot proposed) {
        return submit("write", operationId, expectedVersion, proposed.values(), null);
    }

    public Mono<Submission> rollback(String operationId, String expectedVersion, RuntimeConfigSource source) {
        return submit("rollback", operationId, expectedVersion, source.reference(), source);
    }

    private Mono<Submission> submit(String mode, String operationId, String expectedVersion,
                                    Map<String, Object> candidate, RuntimeConfigSource source) {
        validateOperationId(operationId);
        return operationCommand(mode, expectedVersion, mapper.writeValueAsString(candidate), operationId)
                .map(reply -> {
                    var snapshot = confirmed(reply, mode, expectedVersion);
                    var receipt = receipt(reply);
                    if (!operationId.equals(receipt.get("operationId")) || !expectedVersion.equals(receipt.get("expectedVersion"))
                            || !"committed".equals(receipt.get("status"))
                            || !snapshot.response().equals(receipt.get("after")))
                        throw new IllegalStateException("Mismatched operation acknowledgement");
                    if (source != null && (!"rollback".equals(receipt.get("operationType")) || !source.matches(receipt.get("source")))
                            || source == null && "rollback".equals(receipt.get("operationType")))
                        throw new IllegalStateException("Mismatched operation type or rollback source");
                    try { adopt(snapshot, true); }
                    catch (ConfigProblem error) { throw error.detail("receipt", receipt); }
                    return new Submission(snapshot, receipt, Boolean.TRUE.equals(reply.get("replayed")));
                })
                .onErrorMap(error -> {
                    var problem = (ConfigProblem) transport(error, true);
                    return problem.detail("operationId", operationId);
                });
    }

    /** A receipt query does not adopt its historical snapshot, nor read current values to attribute an operation. */
    public Mono<Map<String, Object>> operation(String operationId) {
        validateOperationId(operationId);
        return operationCommand("operation", "", "{}", operationId)
                .map(reply -> {
                    String status = String.valueOf(reply.get("status"));
                    if (!List.of("committed", "rejected", "unknown").contains(status))
                        throw new IllegalStateException("Receipt unavailable");
                    var body = copy(reply);
                    if (!status.equals("unknown")) {
                        var receipt = receipt(reply);
                        if (!operationId.equals(receipt.get("operationId")) || !status.equals(receipt.get("status")))
                            throw new IllegalStateException("Mismatched receipt");
                    }
                    body.put("operationId", operationId);
                    body.put("source", "redis-receipt");
                    return body;
                })
                .onErrorMap(error -> new ConfigProblem(503, "CONFIG_OPERATION_UNAVAILABLE", "unknown",
                        "无法读取可靠回执；不能判定原操作是否执行")
                        .detail("status", "unknown").detail("operationId", operationId));
    }

    public Mono<Map<String, Object>> history(String cursor, int limit) {
        if (limit < 1 || limit > 50) throw ConfigProblem.validation("limit", "limit 必须为 1–50");
        if (!cursor.isEmpty()) {
            try { RuntimeConfigSnapshot.revision(cursor); }
            catch (IllegalArgumentException error) { throw ConfigProblem.validation("cursor", "历史游标格式非法"); }
        }
        return operationCommand("history", cursor, String.valueOf(limit), "")
                .map(reply -> {
                    if ("cursor-invalid".equals(reply.get("status")))
                        throw new ConfigProblem(409, "CONFIG_HISTORY_CURSOR_INVALID", "not-applicable", "存储世代已变化，请重新打开历史");
                    if (!"ok".equals(reply.get("status"))) {
                        confirmed(reply, "read", null);
                        throw new IllegalStateException("History unavailable");
                    }
                    var body = copy(reply);
                    // Redis cjson represents an empty Lua table as {}.
                    if (body.get("entries") instanceof Map<?, ?> entries && entries.isEmpty()) body.put("entries", List.of());
                    body.put("source", "redis-history");
                    return body;
                }).onErrorMap(error -> transport(error, false));
    }

    /** A preview is one authority read of current + retained source; it does not reserve either. */
    public Mono<Map<String, Object>> previewRollback(RuntimeConfigSource source) {
        return operationCommand("rollback-preview", "", mapper.writeValueAsString(source.reference()), "")
                .map(reply -> {
                    if (!"ok".equals(reply.get("status"))) confirmed(reply, "read", null);
                    if (!(reply.get("current") instanceof Map<?, ?> current)
                            || !(reply.get("target") instanceof Map<?, ?> target)
                            || !source.matches(reply.get("source")))
                        throw new IllegalStateException("Invalid rollback preview");
                    RuntimeConfigSnapshot.from(current, String.valueOf(current.get("version")));
                    RuntimeConfigSnapshot.from(target, String.valueOf(target.get("version")));
                    if (!source.version().equals(target.get("version"))) throw new IllegalStateException("Source mismatch");
                    return copy(reply);
                }).onErrorMap(error -> transport(error, false));
    }

    public static void validateOperationId(String id) {
        if (id == null || !id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
            throw ConfigProblem.validation("operationId", "operationId 必须是小写 UUID");
    }

    /** Package visibility permits deterministic completion ordering in tests. */
    Mono<Map<?, ?>> command(String mode, String expected, RuntimeConfigSnapshot proposed) {
        return execute(List.of(mode, expected, proposed == null ? "{}" : mapper.writeValueAsString(proposed.values())));
    }
    Mono<Map<?, ?>> operationCommand(String mode, String expected, String candidate, String operationId) {
        return execute(List.of(mode, expected, candidate, operationId, instanceId));
    }
    private Mono<Map<?, ?>> execute(List<String> args) {
        return Mono.defer(() -> redis.execute(SCRIPT, List.of(redisKey), args).single().timeout(Duration.ofSeconds(3))
                .map(json -> (Map<?, ?>) mapper.readValue(json, Map.class)));
    }
    static String storageScript() { return SCRIPT.getScriptAsString(); }
    RuntimeConfigSnapshot decodeReadReply(String json) {
        return confirmed(mapper.readValue(json, Map.class), "read", null);
    }
    private static Map<String, Object> copy(Map<?, ?> reply) {
        var out = new LinkedHashMap<String, Object>();
        reply.forEach((key, value) -> out.put(String.valueOf(key), value));
        return out;
    }
    private Map<String, Object> receipt(Map<?, ?> reply) {
        if (!(reply.get("receipt") instanceof Map<?, ?> receipt)
                || !(receipt.get("recordedAt") instanceof Number) || !(receipt.get("expiresAt") instanceof Number))
            throw new IllegalStateException("Missing operation receipt");
        return copy(receipt);
    }
    private RuntimeConfigSnapshot confirmed(Map<?, ?> reply, String mode, String expected) {
        String status = String.valueOf(reply.get("status"));
        String outcome = List.of("write", "rollback").contains(mode) ? "not-written" : "not-applicable";
        if ("ok".equals(status) || "conflict".equals(status)) {
            if (!(reply.get("snapshot") instanceof Map<?, ?> value) || !(value.get("version") instanceof String version))
                throw new IllegalStateException("Invalid storage acknowledgement");
            RuntimeConfigSnapshot snapshot;
            try { snapshot = RuntimeConfigSnapshot.from(value, version); }
            catch (RuntimeException error) { throw new IllegalStateException("Invalid storage snapshot", error); }
            if ("conflict".equals(status)) {
                String adoptionIssue = null;
                try { properties.adopt(snapshot); } catch (IllegalStateException error) { adoptionIssue = error.getMessage(); }
                throw new ConfigProblem(409, "CONFIG_VERSION_CONFLICT", "not-written",
                        "配置已被其他提交更新，请核对最新值与草稿后再次提交")
                        .detail("expectedVersion", expected).detail("current", snapshot.response())
                        .detail("receipt", reply.get("receipt")).detail("replayed", reply.get("replayed"))
                        .detail("adoptionIssue", adoptionIssue);
            }
            return snapshot;
        }
        if ("history-unavailable".equals(status))
            throw new ConfigProblem(410, "CONFIG_HISTORY_UNAVAILABLE", outcome,
                    "来源历史已过期、被裁剪或不匹配；未执行恢复，请重新选择可用历史");
        if ("operation-mismatch".equals(status))
            throw new ConfigProblem(409, "CONFIG_OPERATION_MISMATCH", "not-written", "此操作 ID 已绑定不同请求；本请求未写入，请查询原操作");
        if ("receipt-capacity".equals(status))
            throw new ConfigProblem(429, "CONFIG_RECEIPT_CAPACITY", "not-written", "未过期回执已达 512 条；不会提前删除回执，请稍后发起新操作");
        String message = switch (status) {
            case "missing" -> "存储配置键缺失；保留本地快照，需要受控恢复后重启";
            case "invalid" -> "存储配置格式非法或尚未迁移；保留本地快照";
            case "exhausted" -> "配置版本序号已用尽，需要受控迁移";
            case "rejected" -> "Redis 明确拒绝写入；本次请求未写入";
            case "bad-request" -> "操作请求格式非法；本次请求未写入";
            default -> null;
        };
        if (message == null) throw new IllegalStateException("Unrecognized storage acknowledgement");
        throw new ConfigProblem(503, "CONFIG_STORAGE_" + status.toUpperCase(java.util.Locale.ROOT), outcome, message);
    }
    private void adopt(RuntimeConfigSnapshot snapshot, boolean committed) {
        try { properties.adopt(snapshot); }
        catch (IllegalStateException error) {
            throw new ConfigProblem(503, "CONFIG_ADOPTION_FAILED", committed ? "committed" : "not-applicable",
                    "存储已确认，但本实例无法采用；需要检查存储世代并受控重启").detail("confirmed", snapshot.response());
        }
    }
    private Throwable transport(Throwable error, boolean write) {
        if (error instanceof ConfigProblem) return error;
        return new ConfigProblem(503, write ? "CONFIG_WRITE_UNCONFIRMED" : "CONFIG_READ_UNAVAILABLE",
                write ? "unknown" : "not-applicable", write ? "未收到可靠确认；请按 operationId 查询本次提交结果"
                        : "无法从 Redis 确认；本地采用值不能代替存储确认");
    }
}
