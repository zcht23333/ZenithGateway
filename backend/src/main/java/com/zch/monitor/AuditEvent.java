package com.zch.monitor;

/** Immutable ownership transfer from the HTTP thread to the audit worker. */
public record AuditEvent(String eventId, long timestamp, String method, String path,
                         int statusCode, long durationMs, String clientIp, String outcome,
                         @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) String reason,
                         @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) String phase,
                         @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) String rateLimitOutcome,
                         @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) String rateLimitReason,
                         @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) String rateLimitEvent,
                         @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) String rateLimitAction,
                         @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) String rateLimitExecution,
                         @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) String rateLimitRejectionSource) {
    public AuditEvent(String eventId,long timestamp,String method,String path,int statusCode,long durationMs,String clientIp,String outcome,String reason,String phase,String rateLimitOutcome,String rateLimitReason){
        this(eventId,timestamp,method,path,statusCode,durationMs,clientIp,outcome,reason,phase,rateLimitOutcome,rateLimitReason,null,null,null,null);
    }
    public AuditEvent(String eventId,long timestamp,String method,String path,int statusCode,long durationMs,String clientIp,String outcome){
        this(eventId,timestamp,method,path,statusCode,durationMs,clientIp,outcome,null,null,null,null);
    }
    public AuditEvent(String eventId,long timestamp,String method,String path,int statusCode,long durationMs,String clientIp,String outcome,String reason,String phase){
        this(eventId,timestamp,method,path,statusCode,durationMs,clientIp,outcome,reason,phase,null,null);
    }
    static AuditEvent copyOf(TrafficData event, String id) {
        return new AuditEvent(id, event.getTimestamp(), event.getMethod(), event.getPath(),
                event.getStatusCode(), event.getDurationMs(), event.getClientIp(), event.getOutcome(),event.getReason(),event.getPhase(),event.getRateLimitOutcome(),event.getRateLimitReason(),event.getRateLimitEvent(),event.getRateLimitAction(),event.getRateLimitExecution(),event.getRateLimitRejectionSource());
    }

    // Conservative reservation covering retained UTF-16 strings, escaped JSON and entry overhead.
    long reservedBytes() {
        return 512L + 12L * (length(eventId) + length(method) + length(path) + length(clientIp) + length(outcome) + length(reason) + length(phase) + length(rateLimitOutcome) + length(rateLimitReason) + length(rateLimitEvent) + length(rateLimitAction) + length(rateLimitExecution) + length(rateLimitRejectionSource));
    }
    private static int length(String value) { return value == null ? 0 : value.length(); }
}
