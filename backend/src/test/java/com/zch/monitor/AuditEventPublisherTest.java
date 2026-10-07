package com.zch.monitor;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;
import com.zch.config.GatewayRuntimeProperties;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Duration;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class AuditEventPublisherTest {
    private final GatewayRuntimeProperties properties = new GatewayRuntimeProperties();
    private final JsonMapper mapper = JsonMapper.builder().build();

    private AuditEventPublisher publisher(AuditBatchWriter writer) {
        var result = new AuditEventPublisher(writer, mapper, properties, new SimpleMeterRegistry());
        result.start();
        return result;
    }
    private TrafficData event() { return TrafficMetricsServiceTest.data(System.currentTimeMillis(), 10, 200); }
    private void drained(AuditEventPublisher publisher) {
        await().atMost(Duration.ofSeconds(10)).until(() -> publisher.status().pending() == 0);
        assertReconciles(publisher.status());
    }
    static void assertReconciles(AuditStatus status) {
        assertEquals(status.received(), status.persisted() + status.dropped() + status.uncertain() + status.pending());
        assertTrue(status.pending() <= status.capacity());
        assertTrue(status.reservedBytes() <= status.maxReservedBytes());
    }

    @Test void concurrentProducersLoseNoIdsAndDoNotDuplicate() {
        properties.getAudit().setBufferSize(50000);
        properties.getAudit().setBufferMaxBytes(128 * 1024 * 1024);
        Set<String> ids = ConcurrentHashMap.newKeySet();
        AtomicInteger duplicates = new AtomicInteger();
        var publisher = publisher((batch, rows, timeout) -> {
            for (String row : rows) if (!ids.add(mapper.readTree(row).get("eventId").asString())) duplicates.incrementAndGet();
        });
        try {
            IntStream.range(0, 40000).parallel().forEach(i -> publisher.publish(event()));
            drained(publisher);
            assertEquals(40000, ids.size());
            assertEquals(0, duplicates.get());
            assertEquals(40000, publisher.status().persisted());
            assertEquals(0, publisher.status().dropped());
        } finally { publisher.stop(); }
    }

    @Test void capacityIncludesInFlightAndRejectsWithoutWaitingForRedis() throws Exception {
        properties.getAudit().setBufferSize(4);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        var publisher = publisher((batch, rows, timeout) -> {
            entered.countDown();
            assertTrue(release.await(3, TimeUnit.SECONDS));
        });
        try {
            publisher.publish(event());
            assertTrue(entered.await(1, TimeUnit.SECONDS));
            IntStream.range(0, 99).parallel().forEach(i -> publisher.publish(event()));
            var status = publisher.status();
            assertEquals(4, status.pending());
            assertEquals(96, status.droppedByReason().get("queue_full"));
            assertTrue(status.inFlight() >= 1);
            assertReconciles(status);
            release.countDown();
            drained(publisher);
            assertEquals(4, publisher.status().persisted());
        } finally { release.countDown(); publisher.stop(); }
    }

    @Test void byteBudgetAndOversizedEventsHaveDistinctCounters() throws Exception {
        properties.getAudit().setEventMaxBytes(1024);
        properties.getAudit().setBufferMaxBytes(1024);
        CountDownLatch release = new CountDownLatch(1);
        var publisher = publisher((batch, rows, timeout) -> release.await(1, TimeUnit.SECONDS));
        try {
            for (int i = 0; i < 2; i++) {
                var small = event();
                small.setMethod(null); small.setPath(null); small.setClientIp(null); small.setOutcome(null);
                publisher.publish(small);
            }
            var huge = event(); huge.setPath("x".repeat(10000)); publisher.publish(huge);
            var status = publisher.status();
            assertEquals(1, status.droppedByReason().get("byte_limit"));
            assertEquals(1, status.droppedByReason().get("oversized"));
            assertReconciles(status);
        } finally { release.countDown(); publisher.stop(); }
    }

    @Test void serializationFailureIsKnownLossAndWorkerContinues() throws Exception {
        JsonMapper failing = spy(JsonMapper.builder().build());
        doThrow(new JacksonException("test serialization") {}).doCallRealMethod()
                .when(failing).writeValueAsString(any());
        var publisher = new AuditEventPublisher((id, rows, timeout) -> { }, failing, properties, new SimpleMeterRegistry());
        publisher.start();
        try {
            publisher.publish(event()); publisher.publish(event());
            drained(publisher);
            assertEquals(1, publisher.status().persisted());
            assertEquals(1, publisher.status().droppedByReason().get("serialization"));
        } finally { publisher.stop(); }
    }

    @Test void retriesKeepBatchIdAndPayloadStable() {
        AtomicInteger attempts = new AtomicInteger();
        Set<String> batches = new HashSet<>();
        Set<List<String>> payloads = new HashSet<>();
        var publisher = publisher((id, rows, timeout) -> {
            batches.add(id); payloads.add(rows);
            if (attempts.incrementAndGet() == 1) throw new java.net.SocketTimeoutException("reply lost");
        });
        try {
            publisher.publish(event());
            drained(publisher);
            assertEquals(2, attempts.get());
            assertEquals(1, batches.size());
            assertEquals(1, payloads.size());
            assertEquals(1, publisher.status().received());
            assertEquals(1, publisher.status().persisted());
            assertEquals(1, publisher.status().retries());
        } finally { publisher.stop(); }
    }

    @Test void exhaustedWriteIsUncertainAndNextBatchCanRecover() {
        properties.getAudit().setCommandTimeoutMs(10);
        properties.getAudit().setRetryMaxElapsedMs(60);
        AtomicInteger mode = new AtomicInteger();
        var publisher = publisher((id, rows, timeout) -> {
            if (mode.get() == 0) throw new java.net.SocketTimeoutException();
        });
        try {
            publisher.publish(event());
            drained(publisher);
            assertEquals(1, publisher.status().uncertain());
            assertEquals(0, publisher.status().dropped());
            mode.set(1);
            publisher.publish(event());
            drained(publisher);
            assertEquals(1, publisher.status().persisted());
        } finally { publisher.stop(); }
    }

    @Test void gracefulStopDrainsAndRejectsFurtherAdmission() {
        var publisher = publisher((id, rows, timeout) -> { });
        for (int i = 0; i < 500; i++) publisher.publish(event());
        publisher.stop();
        assertEquals(500, publisher.status().persisted());
        assertEquals(0, publisher.status().pending());
        publisher.publish(event());
        assertEquals(1, publisher.status().droppedByReason().get("shutdown"));
        assertReconciles(publisher.status());
    }

    @Test void shutdownDeadlineClassifiesUnsentAndUnconfirmedSeparately() throws Exception {
        properties.getAudit().setBatchSize(1);
        properties.getAudit().setShutdownDrainTimeoutMs(100);
        CountDownLatch entered = new CountDownLatch(1);
        var publisher = publisher((id, rows, timeout) -> {
            entered.countDown();
            Thread.sleep(Math.min(30, timeout.toMillis()));
            throw new java.net.SocketTimeoutException();
        });
        publisher.publish(event());
        assertTrue(entered.await(1, TimeUnit.SECONDS));
        for (int i = 0; i < 10; i++) publisher.publish(event());
        publisher.stop();
        assertEquals(1, publisher.status().uncertain());
        assertEquals(10, publisher.status().droppedByReason().get("shutdown"));
        assertEquals(0, publisher.status().pending());
        assertReconciles(publisher.status());
    }

    @Test void queuedDataIsImmutableAfterPublication() throws Exception {
        properties.getAudit().setBatchSize(1);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        var paths = new java.util.concurrent.CopyOnWriteArrayList<String>();
        var publisher = publisher((id, rows, timeout) -> {
            entered.countDown();
            assertTrue(release.await(2, TimeUnit.SECONDS));
            for (String row : rows) paths.add(mapper.readTree(row).get("path").asString());
        });
        try {
            publisher.publish(event());
            assertTrue(entered.await(1, TimeUnit.SECONDS));
            var mutable = event();
            mutable.setPath("/before");
            publisher.publish(mutable);
            mutable.setPath("/after");
            release.countDown();
            drained(publisher);
            assertEquals(List.of("/test", "/before"), paths);
        } finally { release.countDown(); publisher.stop(); }
    }

    @Test void batchByteLimitIsHonoredEvenWhenCountLimitIsLarger() {
        properties.getAudit().setEventMaxBytes(2048);
        properties.getAudit().setBatchMaxBytes(2048);
        AtomicInteger maxBatch = new AtomicInteger();
        var publisher = publisher((id, rows, timeout) -> maxBatch.accumulateAndGet(rows.size(), Math::max));
        try {
            for (int i = 0; i < 20; i++) publisher.publish(event());
            drained(publisher);
            assertEquals(20, publisher.status().persisted());
            // Two event reservations exceed this batch's byte limit.
            assertEquals(1, maxBatch.get());
        } finally { publisher.stop(); }
    }

    @Test void unsafeRetryAndCapacityConfigurationFailsAtStartup() {
        properties.getAudit().setDedupTtlSeconds(10);
        assertThrows(IllegalArgumentException.class, properties.getAudit()::validate);
        properties.getAudit().setDedupTtlSeconds(120);
        properties.getAudit().setBatchSize(1001);
        assertThrows(IllegalArgumentException.class, properties.getAudit()::validate);
        properties.getAudit().setBatchSize(100);
        properties.getAudit().setBufferMaxBytes(1);
        assertThrows(IllegalArgumentException.class, properties.getAudit()::validate);
    }
    @Test void repeatedDrainSharesOneWorkerCloseAndStillInvokesEachLifecycleCallback() throws Exception {
        var writer = mock(AuditBatchWriter.class);
        var publisher = publisher(writer);
        for (int n=0;n<20;n++) publisher.publish(event());
        var callbacks = new CountDownLatch(2);
        publisher.stop(callbacks::countDown); publisher.stop(callbacks::countDown);
        assertTrue(callbacks.await(2,TimeUnit.SECONDS)); publisher.stop();
        verify(writer,times(1)).close();
        assertEquals(20,publisher.status().persisted()); assertFalse(publisher.isRunning());
        assertReconciles(publisher.status());
    }
}
