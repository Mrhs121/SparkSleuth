#!/usr/bin/env bash
# Start a local Spark History Server for development and testing.
set -euo pipefail

SPARK_HOME="${SPARK_HOME:-/opt/spark}"
EVENT_DIR="${SPARK_EVENT_DIR:-/tmp/spark-events}"
PORT="${HS_PORT:-18080}"

if [ ! -x "$SPARK_HOME/sbin/start-history-server.sh" ]; then
  echo "SPARK_HOME looks wrong: $SPARK_HOME" >&2
  echo "Set SPARK_HOME=/path/to/spark before running this script." >&2
  exit 1
fi

mkdir -p "$EVENT_DIR"

export SPARK_HISTORY_OPTS="\
-Dspark.history.fs.logDirectory=file:$EVENT_DIR \
-Dspark.history.fs.update.interval=5s \
-Dspark.history.ui.port=$PORT"

"$SPARK_HOME/sbin/start-history-server.sh"

echo
echo "History Server starting on http://localhost:$PORT"
echo "Event log directory: $EVENT_DIR"
echo "Check it with: curl -s http://localhost:$PORT/api/v1/version"
