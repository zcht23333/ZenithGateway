package com.zch.lifecycle;

import com.zch.config.GatewayRuntimeProperties;
import com.zch.config.RuntimeConfigSyncProperties;
import com.zch.route.ActiveRoutes;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TrafficLifecycleController {
    private final TrafficLifecycle lifecycle;
    private final GatewayRuntimeProperties runtime;
    private final ActiveRoutes routes;
    private final String instanceId;
    public TrafficLifecycleController(TrafficLifecycle lifecycle, GatewayRuntimeProperties runtime,
            ActiveRoutes routes, RuntimeConfigSyncProperties identity) {
        this.lifecycle = lifecycle; this.runtime = runtime; this.routes = routes; instanceId = identity.getInstanceId();
    }
    @GetMapping("/settings/lifecycle")
    public ResponseEntity<Map<String,Object>> current() { return response(false); }
    @PostMapping("/settings/lifecycle/drain")
    public ResponseEntity<Map<String,Object>> drain() { lifecycle.beginDrain(); return response(true); }
    private ResponseEntity<Map<String,Object>> response(boolean accepted) {
        var body = lifecycle.status(); body.put("instanceId", instanceId);
        body.put("adoptedRuntimeVersion", runtime.snapshot().version());
        var route = routes.current(); body.put("adoptedRouteVersion", route == null ? null : route.snapshot().version());
        return ResponseEntity.status(accepted ? 202 : 200).cacheControl(CacheControl.noStore()).body(body);
    }
}
