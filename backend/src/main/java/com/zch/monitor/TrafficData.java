package com.zch.monitor;

public class TrafficData {

    private long timestamp;
    private String method;
    private String path;
    private int statusCode;
    private long durationMs;
    private String clientIp;

    public long getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(long timestamp) {
        this.timestamp = timestamp;
    }

    public String getMethod() {
        return method;
    }

    public void setMethod(String method) {
        this.method = method;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public int getStatusCode() {
        return statusCode;
    }

    public void setStatusCode(int statusCode) {
        this.statusCode = statusCode;
    }

    public long getDurationMs() {
        return durationMs;
    }

    public void setDurationMs(long durationMs) {
        this.durationMs = durationMs;
    }

    public String getClientIp() {
        return clientIp;
    }

    public void setClientIp(String clientIp) {
        this.clientIp = clientIp;
    }
    private String eventId;
    public String getEventId() { return eventId; }
    public void setEventId(String value) { eventId = value; }
    private String outcome;
    public String getOutcome() { return outcome; }
    public void setOutcome(String value) { outcome = value; }
    private String reason,phase;
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public String getReason(){return reason;} public void setReason(String value){reason=value;}
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public String getPhase(){return phase;} public void setPhase(String value){phase=value;}
    private String rateLimitOutcome,rateLimitReason;
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public String getRateLimitOutcome(){return rateLimitOutcome;} public void setRateLimitOutcome(String value){rateLimitOutcome=value;}
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public String getRateLimitReason(){return rateLimitReason;} public void setRateLimitReason(String value){rateLimitReason=value;}

    private String rateLimitEvent;
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public String getRateLimitEvent(){return rateLimitEvent;} public void setRateLimitEvent(String value){rateLimitEvent=value;}

    private String rateLimitAction;
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public String getRateLimitAction(){return rateLimitAction;} public void setRateLimitAction(String value){rateLimitAction=value;}

    private String rateLimitExecution;
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public String getRateLimitExecution(){return rateLimitExecution;} public void setRateLimitExecution(String value){rateLimitExecution=value;}

    private String rateLimitRejectionSource;
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public String getRateLimitRejectionSource(){return rateLimitRejectionSource;} public void setRateLimitRejectionSource(String value){rateLimitRejectionSource=value;}
}
