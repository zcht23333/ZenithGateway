package com.zch.route;
import java.util.Map;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
@RestController
@RequestMapping("/settings/routes")
public class DynamicRouteController {
    private final DynamicRouteService service;
    public DynamicRouteController(DynamicRouteService service){this.service=service;}
    public record PublicationRequest(String expectedVersion,RouteRuleDto route){}
    public record DeleteRequest(String expectedVersion){}
    @GetMapping public Mono<ResponseEntity<Map<String,Object>>> list(){return service.read().map(this::ok);}
    @GetMapping("/adopted") public ResponseEntity<Map<String,Object>> adopted(){return ok(service.adopted());}
    @GetMapping("/diagnostics") public ResponseEntity<Map<String,Object>> diagnostics(){return ok(service.diagnostics());}
    @PostMapping public Mono<ResponseEntity<Map<String,Object>>> save(@RequestBody PublicationRequest request){return service.save(request.expectedVersion(),request.route()).map(body->ResponseEntity.status(201).cacheControl(CacheControl.noStore()).body(body));}
    @DeleteMapping("/{id}") public Mono<ResponseEntity<Map<String,Object>>> delete(@PathVariable String id,@RequestBody(required=false) DeleteRequest request){return service.delete(request==null?null:request.expectedVersion(),id).map(this::ok);}
    private ResponseEntity<Map<String,Object>> ok(Map<String,Object> value){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value);}
}
