package com.zch.proxy;

import java.util.concurrent.atomic.AtomicBoolean;
import org.reactivestreams.Publisher;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.http.server.reactive.ServerHttpResponseDecorator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** A closed downstream socket can complete the write Mono after cancelling its body. */
final class ProxyResponseLifecycle extends ServerHttpResponseDecorator {
    private volatile boolean bodyCancelled;

    ProxyResponseLifecycle(ServerHttpResponse delegate) { super(delegate); }
    boolean bodyCancelled() { return bodyCancelled; }

    @Override
    public Mono<Void> writeWith(Publisher<? extends DataBuffer> body) {
        return super.writeWith(observe(body));
    }

    @Override
    public Mono<Void> writeAndFlushWith(Publisher<? extends Publisher<? extends DataBuffer>> body) {
        return super.writeAndFlushWith(observe(body));
    }

    private <T> Flux<T> observe(Publisher<T> body) {
        return Flux.defer(() -> {
            AtomicBoolean terminal = new AtomicBoolean();
            return Flux.from(body).doOnComplete(() -> terminal.set(true))
                    .doOnError(error -> terminal.set(true))
                    .doOnCancel(() -> { if (!terminal.get()) bodyCancelled = true; });
        });
    }
}
