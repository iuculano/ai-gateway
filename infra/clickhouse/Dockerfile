FROM clickhouse/clickhouse-server:26.8

# OS security fixes only.
RUN apt-mark hold clickhouse-server clickhouse-client clickhouse-common-static \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

COPY storage.xml /etc/clickhouse-server/config.d/storage.xml
COPY query-cache.xml /etc/clickhouse-server/config.d/query-cache.xml
