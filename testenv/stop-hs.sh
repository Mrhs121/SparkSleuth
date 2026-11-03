#!/usr/bin/env bash
# Stop the local History Server started by start-hs.sh.
set -euo pipefail

SPARK_HOME="${SPARK_HOME:-/opt/spark}"
"$SPARK_HOME/sbin/stop-history-server.sh"
