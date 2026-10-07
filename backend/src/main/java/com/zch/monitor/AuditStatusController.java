package com.zch.monitor;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuditStatusController {
    private final AuditEventPublisher audit;
    public AuditStatusController(AuditEventPublisher audit) { this.audit = audit; }
    @GetMapping("/monitor/audit/status")
    public AuditStatus status() { return audit.status(); }
}
