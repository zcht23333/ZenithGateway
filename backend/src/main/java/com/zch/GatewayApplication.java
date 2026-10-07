package com.zch;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.web.reactive.config.EnableWebFlux;

/**
 * Zenith-Gateway 启动类
 * 使用 Java 21 + Spring Boot 4.x
 */
@SpringBootApplication
@EnableWebFlux
@ConfigurationPropertiesScan
public class GatewayApplication {

    private static final Logger log = LoggerFactory.getLogger(GatewayApplication.class);

    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
        log.info("🚀 Zenith-Gateway 启动成功！");
        log.info("📡 监控面板地址: http://localhost:8080");
    }
}
