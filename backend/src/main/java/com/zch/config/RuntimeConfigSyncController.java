package com.zch.config;

import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RuntimeConfigSyncController {
    private final RuntimeConfigSync sync;
    public RuntimeConfigSyncController(RuntimeConfigSync sync) { this.sync = sync; }

    /** /settings/** is covered by management authentication. This endpoint never triggers Redis I/O. */
    @GetMapping("/settings/runtime/sync")
    public ResponseEntity<Map<String, Object>> status() {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(sync.status());
    }
}
