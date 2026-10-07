package com.zch.proxy;

import com.zch.monitor.RequestObservation;
import io.netty.channel.ChannelOption;
import java.time.Duration;
import java.util.List;
import org.springframework.boot.web.server.autoconfigure.ServerProperties;
import org.springframework.boot.ssl.SslBundles;
import reactor.netty.http.client.HttpClient;
import org.springframework.cloud.gateway.config.HttpClientCustomizer;
import org.springframework.cloud.gateway.config.HttpClientFactory;
import org.springframework.cloud.gateway.config.HttpClientProperties;
import org.springframework.cloud.gateway.config.HttpClientSslConfigurer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import reactor.netty.resources.ConnectionProvider;
import reactor.netty.NettyPipeline;

@Configuration(proxyBeanMethods=false)
public class ProxyClientConfiguration {
    @Bean(destroyMethod="dispose")
    ConnectionProvider proxyConnections(ProxyPolicy policy) {
        return ConnectionProvider.builder("zenith-proxy")
                .maxConnections(policy.getMaxConnections()).pendingAcquireMaxCount(policy.getMaxPendingAcquires())
                .pendingAcquireTimeout(Duration.ofMillis(policy.getAcquireTimeoutMs()))
                .maxIdleTime(Duration.ofSeconds(30)).maxLifeTime(Duration.ofMinutes(5))
                .evictInBackground(Duration.ofSeconds(15)).metrics(true).build();
    }
    @Bean
    HttpClientFactory proxyHttpClientFactory(HttpClientProperties properties, ServerProperties server,
            SslBundles bundles, List<HttpClientCustomizer> customizers, ConnectionProvider proxyConnections, ProxyPolicy policy,
            org.springframework.cloud.gateway.config.GatewayProperties gateway) {
        java.util.stream.Stream.concat(gateway.getDefaultFilters().stream(),gateway.getRoutes().stream().flatMap(r->r.getFilters().stream()))
                .filter(f->"Retry".equals(f.getName())).findAny().ifPresent(f->{throw new IllegalArgumentException("Proxy Retry filters are disabled in this release");});
        // These actual Gateway properties are consumed again by NettyRoutingFilter per request.
        properties.setConnectTimeout(policy.getConnectTimeoutMs());
        properties.getSsl().setHandshakeTimeout(Duration.ofMillis(policy.getConnectTimeoutMs()));
        properties.getSsl().setCloseNotifyFlushTimeout(Duration.ofMillis(policy.getConnectTimeoutMs()));
        properties.setResponseTimeout(Duration.ofMillis(policy.getHeadersTimeoutMs()));
        // Gateway only applies SSL timeout properties when custom trust/key material exists.
        // Force the same secure builder for default trust too; hostname verification stays enabled.
        HttpClientSslConfigurer ssl = new HttpClientSslConfigurer(properties.getSsl(), server, bundles) {
            @Override public HttpClient configureSsl(HttpClient client) {
                return client.secure(spec -> configureSslContext(getSslProperties(), spec));
            }
        };
        return new HttpClientFactory(properties,server,ssl,customizers) {
            @Override protected ConnectionProvider buildConnectionProvider(HttpClientProperties ignored){return proxyConnections;}
        };
    }
    @Bean
    HttpClientCustomizer proxyClientPolicy(ProxyPolicy policy) {
        return client -> client.disableRetry(true).followRedirect(false)
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS,policy.getConnectTimeoutMs())
                .resolver(spec -> spec.queryTimeout(Duration.ofMillis(policy.getConnectTimeoutMs())))
                .responseTimeout(Duration.ofMillis(policy.getReadIdleTimeoutMs()))
                // Per physical upstream channel: survives pool reuse, has no request state.
                // TransportConfig installs ReactiveBridge before invoking doOnChannelInit.
                .doOnChannelInit((observer,channel,address)->channel.pipeline().addBefore(
                        NettyPipeline.ReactiveBridge,"zenithUpstreamTransportErrors",new UpstreamTransportErrors()))
                .doOnRequest((request,connection)->request.currentContextView().<RequestObservation>getOrEmpty(RequestObservation.CONTEXT_KEY)
                        .ifPresent(o->o.phase="request_sending"))
                .doOnResponse((response,connection)->response.currentContextView().<RequestObservation>getOrEmpty(RequestObservation.CONTEXT_KEY)
                        .ifPresent(o->{o.phase="response_body";o.upstreamStatus=response.status().code();}));
    }
}
