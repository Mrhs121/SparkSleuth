"""A job where one stage heavily dominates the total wall-clock execution time.

Stage 0 finishes in ~1s, but Stage 1 runs a CPU-bound / bottleneck computation
for > 30s, consuming over 90% of the entire pipeline's latency.
"""
import os
import time

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = (
    SparkSession.builder.appName("j10_stage_dominant")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .getOrCreate()
)

# Stage 0: Fast initial data preparation (takes ~1s)
df = spark.range(0, 500_000).withColumn("v", F.col("id") % 100)
count0 = df.filter(F.col("v") == 42).count()
print(f"Stage 0 count: {count0}")

# Stage 1: Bottleneck stage that takes > 30s wall clock time
def delay_task(iterator):
    time.sleep(32)
    for x in iterator:
        yield x

slow_rdd = spark.sparkContext.parallelize([1], 1).mapPartitions(delay_task)
slow_count = slow_rdd.count()
print(f"Stage 1 count: {slow_count}")

spark.stop()
