FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ARG SUPERCRONIC_VERSION=v0.2.47
ARG TARGETARCH

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) SUPERCRONIC_SHA256="dcb1403c188a9438c47d4bba82a9c357fc9351ce91627fb2bae627f0f5becfc4" ;; \
      arm64) SUPERCRONIC_SHA256="e1124aa34294e2bb8ab7002f347f4363ba35097f3daf4d3c44e9d813c1fb2bb8" ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl --fail --silent --show-error --location \
      --output /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}" \
    && echo "${SUPERCRONIC_SHA256}  /usr/local/bin/supercronic" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/supercronic

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/jobs/jobs.js ./dist/jobs/jobs.js
COPY docker/crontab /etc/jungle-bell/crontab

ENTRYPOINT ["/usr/local/bin/supercronic", "-json", "/etc/jungle-bell/crontab"]
