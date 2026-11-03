"""Writes thousands of tiny files, then reads them back — the small-file problem."""
import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = (
    SparkSession.builder.appName("j4_small_files")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .getOrCreate()
)

out = os.environ.get("SPARK_OUT_DIR", "/tmp/sparksleuth-j4")

# 2000 partitions, each writing a file of a few kilobytes.
(
    spark.range(0, 40_000)
    .repartition(2000)
    .write.mode("overwrite")
    .parquet(out)
)

# Now read them back and aggregate: the scan has to open every file.
df = spark.read.parquet(out)
print(f"files rows: {df.agg(F.count(F.lit(1))).collect()[0][0]}")
spark.stop()
