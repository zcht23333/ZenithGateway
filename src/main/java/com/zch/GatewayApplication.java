package com.zch;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.web.reactive.config.EnableWebFlux;

/**
 * Zenith-Gateway 启动类
 * 使用 Java 21 + Spring Boot 3.x
 */
@SpringBootApplication
@EnableWebFlux
@ConfigurationPropertiesScan
public class GatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
        System.out.println("🚀 Zenith-Gateway 启动成功！");
        System.out.println("📡 监控面板地址: http://localhost:8080");
    }
}
