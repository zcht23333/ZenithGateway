package com.zch.route;

import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/settings/routes")
public class DynamicRouteController {

    private final DynamicRouteService dynamicRouteService;

    public DynamicRouteController(DynamicRouteService dynamicRouteService) {
        this.dynamicRouteService = dynamicRouteService;
    }

    @GetMapping
    public Flux<RouteRuleDto> list() {
        return dynamicRouteService.list();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Mono<RouteRuleDto> upsert(@RequestBody RouteRuleDto request) {
        return dynamicRouteService.save(request);
    }

    @DeleteMapping("/{id}")
    public Mono<List<String>> delete(@PathVariable String id) {
        return dynamicRouteService.delete(id)
                .map(removed -> removed
                        ? List.of("deleted", id)
                        : List.of("not_found", id));
    }
}

