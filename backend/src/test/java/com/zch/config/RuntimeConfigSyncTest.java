package com.zch.config;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.test.web.reactive.server.WebTestClient;
import com.zch.filter.AdminAuthFilter;
import static com.zch.config.RuntimeConfigConcurrencyTest.snapshot;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RuntimeConfigSyncTest {
    static class Time extends Clock {
        long millis;
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.parse("2026-09-27T00:00:00Z").plusMillis(millis); }
        void advance(long amount) { millis += amount; }
        long nanos() { return TimeUnit.MILLISECONDS.toNanos(millis); }
    }
    static class Reader implements RuntimeConfigSyncReader {
        RuntimeConfigSnapshot value = snapshot(1);
        Exception failure;
        int reads, closes;
        @Override public RuntimeConfigSnapshot read(Duration timeout) throws Exception {
            reads++;
            assertEquals(Duration.ofSeconds(1), timeout);
            if (failure != null) throw failure;
            return value;
        }
        @Override public void close() { closes++; }
    }
    static class Fixture implements AutoCloseable {
        final Time time = new Time();
        final GatewayRuntimeProperties properties = new GatewayRuntimeProperties(time);
        final RuntimeConfigSyncProperties config = new RuntimeConfigSyncProperties();
        final Reader reader = new Reader();
        final ScheduledExecutorService scheduler = mock(ScheduledExecutorService.class);
        final ScheduledFuture<?> scheduled = mock(ScheduledFuture.class);
        final RuntimeConfigSync sync;
        Fixture() throws Exception {
            properties.adopt(snapshot(1));
            doReturn(scheduled).when(scheduler).scheduleWithFixedDelay(any(), eq(0L), eq(2000L), eq(TimeUnit.MILLISECONDS));
            when(scheduler.awaitTermination(anyLong(), any())).thenReturn(true);
            sync = new RuntimeConfigSync(properties, config, reader, scheduler, time, time::nanos);
        }
        @Override public void close() { sync.destroy(); }
    }

    @Test void pendingDiagnosticsAndDuplicateStartNeverTriggerAnExtraReadOrSchedule() throws Exception {
        try (var f = new Fixture()) {
            for (int i = 0; i < 10; i++) {
                assertEquals("pending", f.sync.status().get("status"));
                assertNull(f.sync.status().get("lastConfirmedVersion"));
            }
            assertEquals(0, f.reader.reads);
            f.sync.start(); f.sync.start();
            verify(f.scheduler, times(1)).scheduleWithFixedDelay(any(), eq(0L), eq(2000L), eq(TimeUnit.MILLISECONDS));
            assertEquals(0, f.reader.reads);
        }
    }

    @Test void sameVersionConfirmationDoesNotAdvanceAdoptionTimeAndNewVersionPublishesBothTogether() throws Exception {
        try (var f = new Fixture()) {
            f.sync.start(); var original = f.properties.adoption();
            f.time.advance(100); f.sync.checkOnce();
            assertEquals("ok", f.sync.status().get("status"));
            assertEquals(original, f.properties.adoption());
            String firstConfirmed = (String) f.sync.status().get("lastConfirmedAt");
            f.time.advance(2000); f.sync.checkOnce();
            assertNotEquals(firstConfirmed, f.sync.status().get("lastConfirmedAt"));
            assertEquals(original, f.properties.adoption());
            f.reader.value = snapshot(2); f.time.advance(2000); f.sync.checkOnce();
            assertEquals(snapshot(2), f.properties.snapshot());
            assertEquals(f.time.instant(), f.properties.adoption().adoptedAt());
            f.time.advance(1000); f.properties.adopt(snapshot(3)); // Management write also timestamps atomically.
            assertEquals("pending", f.sync.status().get("status"));
            assertEquals("CONFIG_SYNC_LOCAL_CHANGED", f.sync.status().get("reasonCode"));
        }
    }

    @Test void failureExpiryAndRecoveryKeepTheLastActualRedisConfirmation() throws Exception {
        try (var f = new Fixture()) {
            f.sync.start(); f.sync.checkOnce();
            var confirmed = f.sync.status().get("lastConfirmedAt");
            f.reader.failure = new TimeoutException("injected"); f.time.advance(2000); f.sync.checkOnce();
            assertEquals("failed", f.sync.status().get("status")); assertEquals(snapshot(1), f.properties.snapshot());
            assertEquals(confirmed, f.sync.status().get("lastConfirmedAt"));
            assertEquals(1L, f.sync.status().get("consecutiveFailures"));
            f.time.advance(10000);
            assertEquals("stale", f.sync.status().get("status"));
            assertEquals("CONFIG_SYNC_READ_FAILED", f.sync.status().get("reasonCode"));
            f.reader.failure = null; f.reader.value = snapshot(4); f.sync.checkOnce();
            assertEquals("ok", f.sync.status().get("status")); assertEquals(snapshot(4), f.properties.snapshot());
            assertEquals(0L, f.sync.status().get("consecutiveFailures")); assertEquals(1L, f.sync.status().get("failures"));
        }
    }

    @Test void freshnessUsesMonotonicTimeAndEvenAHealthyLastCheckCanExpire() throws Exception {
        try (var f = new Fixture()) {
            var ticks = new java.util.concurrent.atomic.AtomicLong();
            var sync = new RuntimeConfigSync(f.properties, f.config, f.reader, f.scheduler, f.time, ticks::get);
            try {
                sync.start(); sync.checkOnce();
                f.time.advance(60000); // Wall clock jumps forward; freshness must not change.
                assertEquals("ok", sync.status().get("status"));
                assertEquals(0L, sync.status().get("confirmationAgeMs"));
                ticks.set(TimeUnit.MILLISECONDS.toNanos(10001)); f.time.advance(-120000);
                assertEquals("stale", sync.status().get("status"));
                assertEquals("ok", sync.status().get("lastCheckOutcome"));
                assertEquals("CONFIG_SYNC_CONFIRMATION_EXPIRED", sync.status().get("reasonCode"));
                assertEquals(10001L, sync.status().get("confirmationAgeMs"));
            } finally { sync.destroy(); }
        }
    }

    @Test void missingInvalidAndForeignGenerationsKeepTheOriginalCompleteSnapshot() throws Exception {
        try (var f = new Fixture()) {
            f.sync.start(); f.sync.checkOnce();
            for (String code : new String[]{"CONFIG_STORAGE_MISSING", "CONFIG_STORAGE_INVALID"}) {
                f.reader.failure = new ConfigProblem(503, code, "not-applicable", "injected");
                f.sync.checkOnce();
                assertEquals(code, f.sync.status().get("reasonCode"));
                assertEquals(snapshot(1), f.properties.snapshot());
                assertEquals(snapshot(1).version(), f.sync.status().get("lastConfirmedVersion"));
            }
            f.reader.failure = null;
            f.reader.value = new RuntimeConfigSnapshot("22222222-2222-2222-2222-222222222222:7",
                    snapshot(2).rateLimit(), snapshot(2).monitor());
            f.sync.checkOnce();
            assertEquals("CONFIG_SYNC_GENERATION_CHANGED", f.sync.status().get("reasonCode"));
            assertEquals(f.reader.value.version(), f.sync.status().get("lastConfirmedVersion"));
            assertEquals(snapshot(1), f.properties.snapshot());
            f.reader.value = new RuntimeConfigSnapshot(snapshot(1).version(), snapshot(2).rateLimit(), snapshot(2).monitor());
            f.sync.checkOnce();
            assertEquals("CONFIG_SYNC_VERSION_CONTENT_MISMATCH", f.sync.status().get("reasonCode"));
            assertEquals(false, f.sync.status().get("matchesLastConfirmation"));
        }
    }

    @Test void aHeldOldReadCannotUndoANewerManagementAdoptionAndChecksDoNotOverlap() throws Exception {
        var entered = new CountDownLatch(1); var release = new CountDownLatch(1); var reads = new AtomicInteger();
        try (var f = new Fixture(); var worker = Executors.newVirtualThreadPerTaskExecutor()) {
            var reader = new RuntimeConfigSyncReader() {
                @Override public RuntimeConfigSnapshot read(Duration timeout) throws Exception {
                    reads.incrementAndGet(); entered.countDown();
                    assertTrue(release.await(2, TimeUnit.SECONDS)); return snapshot(2);
                }
                @Override public void close() {}
            };
            var sync = new RuntimeConfigSync(f.properties, f.config, reader, f.scheduler, f.time, f.time::nanos);
            try {
                sync.start(); var pending = worker.submit(sync::checkOnce);
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                sync.checkOnce(); assertEquals(1, reads.get()); assertEquals(true, sync.status().get("checking"));
                f.properties.adopt(snapshot(3)); var adopted = f.properties.adoption();
                release.countDown(); pending.get(2, TimeUnit.SECONDS);
                assertEquals(adopted, f.properties.adoption());
                assertEquals(snapshot(2).version(), sync.status().get("lastConfirmedVersion"));
                assertEquals("CONFIG_SYNC_OBSERVATION_BEHIND", sync.status().get("reasonCode"));
            } finally { release.countDown(); sync.destroy(); }
        }
    }

    @Test void aLateReadAfterStopCannotPublishAndClosingIsIdempotent() throws Exception {
        var entered = new CountDownLatch(1); var release = new CountDownLatch(1);
        try (var f = new Fixture(); var worker = Executors.newVirtualThreadPerTaskExecutor()) {
            var reader = new RuntimeConfigSyncReader() {
                @Override public RuntimeConfigSnapshot read(Duration timeout) throws Exception {
                    entered.countDown(); assertTrue(release.await(2, TimeUnit.SECONDS)); return snapshot(2);
                }
                @Override public void close() { release.countDown(); }
            };
            var sync = new RuntimeConfigSync(f.properties, f.config, reader, f.scheduler, f.time, f.time::nanos);
            sync.start(); var pending = worker.submit(sync::checkOnce);
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            sync.destroy(); pending.get(2, TimeUnit.SECONDS); sync.destroy(); sync.start(); sync.checkOnce();
            assertEquals(snapshot(1), f.properties.snapshot()); assertEquals("stopped", sync.status().get("status"));
            verify(f.scheduled).cancel(true); verify(f.scheduler).shutdownNow();
        }
    }

    @Test void theDisabledModeStillExposesLocalStateWithoutCreatingWork() throws Exception {
        try (var f = new Fixture()) {
            f.config.setEnabled(false); f.sync.start(); f.sync.checkOnce();
            assertEquals("disabled", f.sync.status().get("status")); assertEquals(0, f.reader.reads);
            verify(f.scheduler, never()).scheduleWithFixedDelay(any(), anyLong(), anyLong(), any());
        }
    }

    @Test void diagnosticsAreAuthenticatedNotCachedAndNeverReadRedis() throws Exception {
        try (var f = new Fixture()) {
            var auth = new AdminAuthProperties(); auth.setToken("sync-test");
            var web = WebTestClient.bindToController(new RuntimeConfigSyncController(f.sync))
                    .webFilter(new AdminAuthFilter(auth, new MockEnvironment())).build();
            web.get().uri("/settings/runtime/sync").exchange().expectStatus().isUnauthorized();
            web.get().uri("/settings/runtime/sync").header("Authorization", "Bearer sync-test").exchange()
                    .expectStatus().isOk().expectHeader().valueEquals("Cache-Control", "no-store")
                    .expectBody().jsonPath("$.source").isEqualTo("local")
                    .jsonPath("$.confirmationScope").isEqualTo("background-read")
                    .jsonPath("$.adoptedVersion").isEqualTo(snapshot(1).version())
                    .jsonPath("$.lastConfirmedVersion").isEmpty();
            assertEquals(0, f.reader.reads);
        }
    }

    @Test void syncSettingsRejectUnboundedAndIncoherentBudgets() {
        var config = new RuntimeConfigSyncProperties(); config.validate();
        config.setIntervalMs(0); assertThrows(IllegalArgumentException.class, config::validate);
        config.setIntervalMs(2000); config.setTimeoutMs(20000); assertThrows(IllegalArgumentException.class, config::validate);
        config.setTimeoutMs(1000); config.setStaleAfterMs(2000); assertThrows(IllegalArgumentException.class, config::validate);
    }
}
