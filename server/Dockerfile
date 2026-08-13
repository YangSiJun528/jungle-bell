FROM node:24-bookworm-slim AS web-build
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY astro.config.mjs components.json tsconfig*.json vite.config.ts ./
COPY scripts ./scripts
COPY src ./src
ARG PUBLIC_BASE_URL=http://127.0.0.1:8080
ENV JUNGLE_BELL_PUBLIC_ORIGIN=${PUBLIC_BASE_URL}
ENV ASTRO_TELEMETRY_DISABLED=1
RUN npm run build

FROM eclipse-temurin:21-jdk-noble AS server-build
WORKDIR /workspace/server
COPY server/gradlew server/gradlew.bat server/settings.gradle.kts server/build.gradle.kts server/gradle.properties ./
COPY server/gradle ./gradle
RUN chmod +x gradlew
RUN ./gradlew --no-daemon dependencies --quiet >/dev/null
COPY server/src ./src
COPY --from=web-build /workspace/dist ./src/main/resources/static
RUN ./gradlew --no-daemon clean test bootJar

FROM eclipse-temurin:21-jre-noble
RUN apt-get update \
    && apt-get install --no-install-recommends -y curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system jungle-bell \
    && useradd --system --gid jungle-bell --home-dir /app --shell /usr/sbin/nologin jungle-bell
WORKDIR /app
COPY --from=server-build /workspace/server/build/libs/*.jar /app/jungle-bell.jar
USER jungle-bell
EXPOSE 8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70 -XX:+ExitOnOutOfMemoryError"
ENTRYPOINT ["java", "-jar", "/app/jungle-bell.jar"]
