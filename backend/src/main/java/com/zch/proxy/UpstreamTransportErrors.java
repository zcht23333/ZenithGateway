package com.zch.proxy;

import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import io.netty.channel.unix.Errors.NativeIoException;
import java.net.SocketException;

/** Labels socket failures at the owned upstream channel, not at the whole proxy chain. */
final class UpstreamTransportErrors extends ChannelInboundHandlerAdapter {
    @Override public void exceptionCaught(ChannelHandlerContext context, Throwable error) {
        context.fireExceptionCaught(mark(error));
    }

    static Throwable mark(Throwable error) {
        // Preserve connect, TLS and timeout classifications, including their original causes.
        if (!"proxy_internal_error".equals(ProxyFailure.classify(error).reason())) return error;
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof SocketException || cause instanceof NativeIoException) {
                return new ProxyFailure.UpstreamDisconnect(error);
            }
        }
        // A generic IOException could be local file/body processing, not an upstream failure.
        return error;
    }
}
