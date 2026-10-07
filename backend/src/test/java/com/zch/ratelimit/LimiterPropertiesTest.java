package com.zch.ratelimit;

import java.util.List;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class LimiterPropertiesTest {
    @Test void defaultsAndSynchronousHandoffHaveFiniteResourceLimits() {
        var p = new LimiterProperties();
        assertDoesNotThrow(p::validate);
        assertEquals(8, p.getWorkers());
        assertFalse(p.isResultHandoffEnabled(), "The measured handoff candidate is opt-in until its health gate passes");
        assertEquals(64, p.getQueueCapacity());
        assertEquals(500, p.getDecisionTimeoutMs());
        p.setQueueCapacity(0);
        assertDoesNotThrow(p::validate);
    }

    @Test void invalidStartupLimitsCannotCreateUnboundedOrAmbiguousOwnership() {
        List<Consumer<LimiterProperties>> invalid = List.of(
            p -> p.setResultWorkers(0), p -> p.setResultWorkers(17),
            p -> p.setWorkers(0), p -> p.setWorkers(65),
            p -> p.setQueueCapacity(-1), p -> p.setQueueCapacity(4097),
            p -> p.setDecisionTimeoutMs(49), p -> p.setDecisionTimeoutMs(2001),
            p -> p.setProbeIntervalMs(99), p -> p.setProbeIntervalMs(30001),
            p -> p.setNamespace(null), p -> p.setNamespace(""),
            p -> p.setNamespace("unsafe*"), p -> p.setNamespace("n".repeat(129))
        );
        for (var change : invalid) {
            var p = new LimiterProperties();
            change.accept(p);
            assertThrows(IllegalArgumentException.class, p::validate);
        }
    }
}
