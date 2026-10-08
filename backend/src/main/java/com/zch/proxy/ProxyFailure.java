package com.zch.proxy;

import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.netty.channel.ConnectTimeoutException;
import io.netty.handler.timeout.ReadTimeoutException;
import io.netty.handler.ssl.SslHandshakeTimeoutException;
import java.net.ConnectException;
import java.net.UnknownHostException;
import java.util.concurrent.TimeoutException;
import javax.net.ssl.SSLException;
import reactor.netty.http.client.PrematureCloseException;
import org.springframework.web.reactive.function.client.WebClientException;

/** Bounded reason vocabulary; never expose exception text or upstream credentials. */
public record ProxyFailure(String reason, int status, boolean breakerFailure) {
    public static final class TotalTimeout extends RuntimeException {}
    public static final class ClientCancelled extends RuntimeException {}
    /** Created only by the outbound HTTP channel handler, never by downstream I/O. */
    // Identify an onward HTTP-client failure to Spring's disconnected-client classifier.
    // Otherwise a Linux root-cause message can be mistaken for a downstream disconnect:
    // HttpWebHandlerAdapter swallows it after commit instead of closing the partial response.
    // Keep the original cause for diagnostics; do not globally suppress client cancellation.
    static final class UpstreamDisconnect extends WebClientException {
        UpstreamDisconnect(Throwable cause) { super("Upstream transport disconnected", cause); }
    }
    public static ProxyFailure classify(Throwable error) {
        for(Throwable cause=error;cause!=null;cause=cause.getCause()) {
            if(cause instanceof ClientCancelled)return new ProxyFailure("client_cancelled",0,false);
            if(cause instanceof CallNotPermittedException)return new ProxyFailure("circuit_open",503,false);
            if(cause instanceof TotalTimeout)return new ProxyFailure("proxy_total_timeout",504,true);
            if(cause instanceof ConnectTimeoutException)return new ProxyFailure("upstream_connect_timeout",504,true);
            if(cause instanceof ReadTimeoutException)return new ProxyFailure("upstream_read_idle",504,true);
            if(cause instanceof SslHandshakeTimeoutException)return new ProxyFailure("upstream_tls_timeout",504,true);
            if(cause.getClass().getSimpleName().equals("PoolAcquireTimeoutException"))return new ProxyFailure("proxy_pool_timeout",503,false);
            if(cause.getClass().getSimpleName().equals("PoolAcquirePendingLimitException"))return new ProxyFailure("proxy_pool_full",503,false);
            if(cause instanceof TimeoutException || cause instanceof org.springframework.cloud.gateway.support.TimeoutException)return new ProxyFailure("upstream_headers_timeout",504,true);
            if(cause instanceof ConnectException || cause instanceof UnknownHostException)return new ProxyFailure("upstream_connect_error",502,true);
            if(cause instanceof UpstreamDisconnect || cause instanceof PrematureCloseException)return new ProxyFailure("upstream_disconnect",502,true);
            if(cause instanceof SSLException)return new ProxyFailure("upstream_tls_error",502,true);
        }
        return new ProxyFailure("proxy_internal_error",500,false);
    }
}
