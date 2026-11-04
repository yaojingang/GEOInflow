#!/bin/sh
set -eu

# The queue volume is authoritative. Never format a Redpanda volume (or adopt
# an unrelated Kafka cluster) when upgrading the application's Compose file.
data=/var/lib/kafka/data
marker="$data/.liekan-kafka-cluster-id"
if [ -L "$marker" ] || [ -L "$marker.tmp" ] || [ -L "$data/logs" ]; then
  echo 'Kafka refuses symlinked queue identity/data.' >&2
  exit 1
fi
if [ ! -f "$marker" ]; then
  # A killed UUID generator can leave only its temporary file. Retrying is
  # safe only before any logs/other engine files exist; never adopt live data.
  if [ -n "$(find "$data" -mindepth 1 -maxdepth 1 ! -name '.liekan-kafka-cluster-id.tmp' -print -quit)" ] ||
     { [ -e "$marker.tmp" ] && [ ! -f "$marker.tmp" ]; }; then
    echo 'Queue volume is not empty and has no GEOInflow Kafka identity. Keep its original engine; automatic Redpanda conversion is not supported.' >&2
    exit 1
  fi
  /opt/kafka/bin/kafka-storage.sh random-uuid > "$marker.tmp"
  mv "$marker.tmp" "$marker"
fi
CLUSTER_ID=$(cat "$marker")
export CLUSTER_ID
if ! printf '%s\n' "$CLUSTER_ID" | grep -Eq '^[A-Za-z0-9_-]{22}$'; then
  echo 'Invalid persisted Kafka cluster identity.' >&2
  exit 1
fi
if [ -f "$data/logs/meta.properties" ] &&
   ! grep -Fxq "cluster.id=$CLUSTER_ID" "$data/logs/meta.properties"; then
  echo 'Kafka cluster identity differs from its data volume.' >&2
  exit 1
fi
exec /etc/kafka/docker/run
