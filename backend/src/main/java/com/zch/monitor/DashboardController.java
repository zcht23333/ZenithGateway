package com.zch.monitor;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/dashboard")
public class DashboardController {

    private final TrafficMetricsService trafficMetricsService;

    public DashboardController(TrafficMetricsService trafficMetricsService) {
        this.trafficMetricsService = trafficMetricsService;
    }

    @GetMapping("/snapshot")
    public TrafficMetricsSnapshot snapshot() {
        return trafficMetricsService.latestSnapshot();
    }

    @GetMapping("/series")
    public List<TrafficMetricsSnapshot> series(@RequestParam(defaultValue = "60") int size) {
        return trafficMetricsService.recentSnapshots(size);
    }
}

