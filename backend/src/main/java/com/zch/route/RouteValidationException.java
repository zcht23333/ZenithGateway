package com.zch.route;

public class RouteValidationException extends IllegalArgumentException {
    private final String field;
    public RouteValidationException(String field, String message) {
        super(message);
        this.field = field;
    }
    public String getField() { return field; }
}
