package com.zch.proxy;

import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProxyDiagnosticsController {
    private final ProxyBreakers breakers;
    public ProxyDiagnosticsController(ProxyBreakers breakers){this.breakers=breakers;}
    @GetMapping("/settings/proxy/diagnostics")
    public ResponseEntity<Map<String,Object>> current(){
        var body=breakers.diagnostics();var pool=new java.util.LinkedHashMap<String,Object>();
        for(String metric:java.util.List.of("active.connections","idle.connections","pending.connections","total.connections")){
            var gauges=io.micrometer.core.instrument.Metrics.globalRegistry.find("reactor.netty.connection.provider."+metric).tag("name","zenith-proxy").gauges();
            pool.put(metric,gauges.isEmpty()?null:gauges.stream().mapToDouble(io.micrometer.core.instrument.Gauge::value).sum());
        }
        body.put("pool",pool);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
