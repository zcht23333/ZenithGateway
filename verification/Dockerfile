FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node
FROM mcr.microsoft.com/openjdk/jdk:21-ubuntu@sha256:69e7c7cc0b5365e40718d70759f77b7c4b16e86ddaacfdf499d1c4807ba592d5
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/ /usr/local/
WORKDIR /workspace
COPY .mvn/ .mvn/
COPY mvnw ./
COPY backend/pom.xml backend/pom.xml
COPY backend/src/ backend/src/
COPY frontend/package*.json frontend/
COPY frontend/src/ frontend/src/
COPY frontend/tests/ frontend/tests/
COPY frontend/*.ts frontend/*.cjs frontend/index.html frontend/tsconfig.json frontend/
COPY verification/verify.sh verification/verify.sh
CMD ["bash", "verification/verify.sh"]
