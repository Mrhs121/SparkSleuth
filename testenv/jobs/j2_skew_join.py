"""A join skewed on one key, with adaptive skew handling turned off."""
import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = (
    SparkSession.builder.appName("j2_skew_join")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .config("spark.sql.adaptive.enabled", "false")
    .config("spark.sql.autoBroadcastJoinThreshold", "-1")  # force a shuffle join
    .config("spark.sql.shuffle.partitions", "50")
    .getOrCreate()
)

# Half of all rows carry key 1; the rest spread over 1000 keys.
facts = (
    spark.range(0, 8_000_000)
    .withColumn(
        "k",
        F.when(F.col("id") % 2 == 0, F.lit(1)).otherwise(F.col("id") % 1000 + 2),
    )
    .withColumn("v", F.col("id") % 100)
)

dim = spark.range(1, 1002).withColumn("label", F.concat(F.lit("label-"), F.col("id").cast("string")))

joined = facts.join(dim.withColumnRenamed("id", "dim_id"), F.col("k") == F.col("dim_id"), "inner")
agg = joined.groupBy("k", "label").agg(F.sum("v").alias("total"), F.count(F.lit(1)).alias("n"))

agg.write.mode("overwrite").parquet(os.environ.get("SPARK_OUT_DIR", "/tmp/sparksleuth-j2"))
print(f"keys: {spark.read.parquet(os.environ.get('SPARK_OUT_DIR', '/tmp/sparksleuth-j2')).count()}")
spark.stop()
