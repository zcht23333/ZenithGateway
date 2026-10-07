package com.zch.proxy;

import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import io.netty.channel.embedded.EmbeddedChannel;
import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketException;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class UpstreamTransportErrorsTest {
    Throwable upstream(Throwable error) {
        var observed=new AtomicReference<Throwable>();
        var channel=new EmbeddedChannel(new UpstreamTransportErrors(),new ChannelInboundHandlerAdapter() {
            @Override public void exceptionCaught(ChannelHandlerContext context,Throwable cause) { observed.set(cause); }
        });
        try { channel.pipeline().fireExceptionCaught(error);return observed.get(); }
        finally { channel.finishAndReleaseAll(); }
    }
    @Test void rawAndWrappedSocketFailuresAreIdentifiedOnlyAtUpstreamBoundary() {
        for(Throwable cause:List.of(new SocketException("Connection reset"),new RuntimeException(new SocketException("localized message")))) {
            assertEquals("proxy_internal_error",ProxyFailure.classify(cause).reason());
            assertFalse(ProxyFailure.classify(cause).breakerFailure());
            var marked=upstream(cause);assertInstanceOf(ProxyFailure.UpstreamDisconnect.class,marked);
            assertSame(cause,marked.getCause());
            assertEquals(new ProxyFailure("upstream_disconnect",502,true),ProxyFailure.classify(new RuntimeException(marked)));
            assertSame(marked,upstream(marked));
        }
    }
    @Test void genericIoAndLocalProcessingErrorsDoNotBecomeUpstreamFailures() {
        for(Throwable error:List.of(new IOException("local read failed"),new RuntimeException(new IOException()),new IllegalStateException())) {
            assertSame(error,upstream(error));assertFalse(ProxyFailure.classify(upstream(error)).breakerFailure());
        }
    }
    @Test void existingConnectTimeoutTlsCancelAndPoolReasonsRemainUnchanged() {
        for(Throwable error:List.of(new ConnectException(),new io.netty.channel.ConnectTimeoutException(),
                io.netty.handler.timeout.ReadTimeoutException.INSTANCE,new javax.net.ssl.SSLException("TLS"),
                new ProxyFailure.ClientCancelled(),new PoolAcquireTimeoutException(),new PoolAcquirePendingLimitException())) {
            assertSame(error,upstream(error));
        }
        assertFalse(ProxyFailure.classify(upstream(new ProxyFailure.ClientCancelled())).breakerFailure());
        assertFalse(ProxyFailure.classify(upstream(new PoolAcquireTimeoutException())).breakerFailure());
        assertFalse(ProxyFailure.classify(upstream(new PoolAcquirePendingLimitException())).breakerFailure());
    }
    // These failures are local acquisition results, never an upstream channel reset.
    static final class PoolAcquireTimeoutException extends RuntimeException {}
    static final class PoolAcquirePendingLimitException extends RuntimeException {}
}
