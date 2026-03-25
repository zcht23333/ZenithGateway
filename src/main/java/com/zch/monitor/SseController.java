package com.zch.monitor;

import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
@RequestMapping("/monitor")
public class SseController {

    private final TrafficMetricsService trafficMetricsService;

    public SseController(TrafficMetricsService trafficMetricsService) {
        this.trafficMetricsService = trafficMetricsService;
    }

    @GetMapping(path = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<TrafficMetricsSnapshot>> stream() {
        return trafficMetricsService.stream()
                .map(snapshot -> ServerSentEvent.<TrafficMetricsSnapshot>builder()
                        .event("traffic")
                        .data(snapshot)
                        .build());
    }

    @GetMapping("/metrics/latest")
    public TrafficMetricsSnapshot latest() {
        return trafficMetricsService.latestSnapshot();
    }
}

