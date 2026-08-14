FROM node:24-bookworm-slim AS web-build
WORKDIR /workspace/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/components.json frontend/tsconfig.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/scripts ./scripts
COPY frontend/src ./src
RUN npm run build:web

FROM eclipse-temurin:21-jdk-noble AS server-build
WORKDIR /workspace/server
COPY server/gradlew server/gradlew.bat server/settings.gradle.kts server/build.gradle.kts server/gradle.properties ./
COPY server/gradle ./gradle
RUN chmod +x gradlew
RUN mkdir -p core api worker \
    && ./gradlew --no-daemon :core:dependencies :api:dependencies :worker:dependencies --quiet >/dev/null
COPY server/core/src ./core/src
COPY server/api/src ./api/src
COPY server/worker/src ./worker/src
COPY --from=web-build /workspace/frontend/dist/web ./api/src/main/resources/static
RUN ./gradlew --no-daemon clean check :api:bootJar :worker:bootJar

FROM eclipse-temurin:21-jre-noble AS runtime-base
RUN apt-get update \
    && apt-get install --no-install-recommends -y curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system jungle-bell \
    && useradd --system --gid jungle-bell --home-dir /app --shell /usr/sbin/nologin jungle-bell
WORKDIR /app
USER jungle-bell
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70 -XX:+ExitOnOutOfMemoryError"

FROM runtime-base AS api-runtime
COPY --from=server-build /workspace/server/api/build/libs/*-SNAPSHOT.jar /app/jungle-bell-api.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/jungle-bell-api.jar"]

FROM runtime-base AS worker-runtime
COPY --from=server-build /workspace/server/worker/build/libs/*-SNAPSHOT.jar /app/jungle-bell-worker.jar
ENTRYPOINT ["java", "-jar", "/app/jungle-bell-worker.jar"]
