"""A severely skewed job with a single long-tail task straggler.

95% of data hashes to partition 0, causing that task to shuffle and compute
for > 5 seconds, while other tasks finish in 50ms.
"""
import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = (
    SparkSession.builder.appName("j9_straggler_skew")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .config("spark.sql.adaptive.enabled", "false")
    .config("spark.sql.shuffle.partitions", "20")
    .getOrCreate()
)

# 10,000,000 rows. Key 0 holds 9,500,000 rows.
df = (
    spark.range(0, 10_000_000)
    .withColumn(
        "skew_key",
        F.when(F.col("id") < 9_500_000, F.lit(0)).otherwise(F.col("id") % 19 + 1)
    )
    .withColumn("payload", F.concat(F.lit("val_"), (F.col("id") % 1000).cast("string")))
)

# Repartition forces shuffle without map-side combiner
shuffled = df.repartition(20, "skew_key")
# CPU-intensive sha2 hashing on the hot partition makes the task run for > 5s
hashed = shuffled.withColumn("h", F.sha2(F.col("payload"), 256))
counted = hashed.groupBy("skew_key", "h").count()

OUT_PATH = os.environ.get("SPARK_OUT_DIR", "/tmp/sparksleuth-j9")
counted.write.mode("overwrite").parquet(OUT_PATH)

print(f"j9 finished. Output records: {spark.read.parquet(OUT_PATH).count()}")
spark.stop()
