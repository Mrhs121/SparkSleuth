#!/usr/bin/env bash
# Run every test job so the History Server has something to diagnose.
#
#   SPARK_HOME=/opt/spark ./testenv/run-all.sh
#   SPARK_MASTER='local-cluster[2,2,1024]' ./testenv/run-all.sh   # closer to a real cluster
#
set -uo pipefail

SPARK_HOME="${SPARK_HOME:-/opt/spark}"
SPARK_MASTER="${SPARK_MASTER:-local[4]}"
SPARK_EVENT_DIR="${SPARK_EVENT_DIR:-/tmp/spark-events}"
SPARK_DRIVER_MEMORY="${SPARK_DRIVER_MEMORY:-1g}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export SPARK_EVENT_LOG_DIR="file:$SPARK_EVENT_DIR"
mkdir -p "$SPARK_EVENT_DIR"

echo "master:  $SPARK_MASTER"
echo "events:  $SPARK_EVENT_DIR"
echo

failed=0
for job in "$HERE"/jobs/j*.py; do
  name="$(basename "$job")"
  printf '%-34s' "$name"
  start=$(date +%s)
  if "$SPARK_HOME/bin/spark-submit" \
      --master "$SPARK_MASTER" \
      --driver-memory "$SPARK_DRIVER_MEMORY" \
      --conf spark.driver.host=127.0.0.1 \
      --conf spark.driver.bindAddress=127.0.0.1 \
      --conf spark.ui.enabled=false \
      --conf spark.eventLog.enabled=true \
      --conf "spark.eventLog.dir=file:$SPARK_EVENT_DIR" \
      "$job" > "/tmp/sparksleuth-$name.log" 2>&1; then
    echo "ok ($(($(date +%s) - start))s)"
  else
    code=$?
    # j5 is meant to fail: it exists to produce task failures.
    if [[ "$name" == j5_* ]]; then
      echo "failed as designed (exit $code, $(($(date +%s) - start))s)"
    else
      echo "FAILED (exit $code) — see /tmp/sparksleuth-$name.log"
      failed=1
    fi
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  echo "Some jobs failed unexpectedly." >&2
  exit 1
fi
echo "All jobs submitted. Give the History Server a few seconds to parse the event logs,"
echo "then run: SPARKSLEUTH_HS_URL=http://localhost:18080 pnpm cli apps"
