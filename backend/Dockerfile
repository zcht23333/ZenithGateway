FROM mcr.microsoft.com/openjdk/jdk:21-ubuntu@sha256:69e7c7cc0b5365e40718d70759f77b7c4b16e86ddaacfdf499d1c4807ba592d5
WORKDIR /app
COPY docker/Probe.java /app/Probe.java
RUN javac -d /app /app/Probe.java
COPY --chown=10001:10001 target/zg-1.0.0.jar /app/gateway.jar
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["java"]
CMD ["-Xms256m", "-Xmx512m", "-XX:+UseG1GC", "-jar", "/app/gateway.jar"]
