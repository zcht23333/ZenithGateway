package com.zch.route;
import java.util.Map;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
@RestControllerAdvice(assignableTypes=DynamicRouteController.class)
public class RouteErrorHandler {
    @ExceptionHandler(RouteValidationException.class)
    public ResponseEntity<Map<String,Object>> invalidRoute(RouteValidationException error){return ResponseEntity.badRequest().cacheControl(CacheControl.noStore()).body(Map.of("code","ROUTE_VALIDATION_FAILED","outcome","not-written","field",error.getField(),"message",error.getMessage()));}
    @ExceptionHandler(RouteProblem.class)
    public ResponseEntity<Map<String,Object>> problem(RouteProblem error){return ResponseEntity.status(error.status()).cacheControl(CacheControl.noStore()).body(error.response());}
}
