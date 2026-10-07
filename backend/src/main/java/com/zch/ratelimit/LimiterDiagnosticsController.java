package com.zch.ratelimit;
import com.zch.config.GatewayRuntimeProperties;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import java.util.Map;
@RestController
public class LimiterDiagnosticsController {
    private final RedisRateLimiter limiter;private final GatewayRuntimeProperties properties;
    public LimiterDiagnosticsController(RedisRateLimiter limiter,GatewayRuntimeProperties properties){this.limiter=limiter;this.properties=properties;}
    @GetMapping("/settings/rate-limit/diagnostics")
    public ResponseEntity<Map<String,Object>> status(){var body=limiter.status();body.put("adopted",properties.snapshot().response());return ResponseEntity.ok().header("Cache-Control","no-store").body(body);}
    @GetMapping("/settings/rate-limit/saturation")
    public ResponseEntity<Map<String,Object>> saturation(@org.springframework.web.bind.annotation.RequestParam(defaultValue="0") long afterSequence){
        if(afterSequence<0)throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,"afterSequence must be non-negative");
        return ResponseEntity.ok().header("Cache-Control","no-store").body(limiter.saturationStatus(afterSequence));
    }
}
