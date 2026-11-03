"""The fixed version of j1: cap the fan-out before joining.

Each side is reduced to the top ads per user first, so the join runs on a small,
already-deduplicated set instead of producing N*N rows.
"""
import os

from pyspark.sql import SparkSession, Window
from pyspark.sql import functions as F

spark = (
    SparkSession.builder.appName("j7_self_join_optimized")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .config("spark.sql.shuffle.partitions", "32")
    .getOrCreate()
)

normal = (
    spark.range(0, 200_000)
    .withColumn("mid", F.col("id"))
    .withColumn("ad_id", F.explode(F.array([F.lit(i) for i in range(16)])))
    .select("mid", "ad_id")
)

power = (
    spark.range(0, 3)
    .withColumn("mid", F.col("id") + 900_000)
    .withColumn("ad_id", F.explode(F.array([F.lit(i) for i in range(6000)])))
    .select("mid", "ad_id")
)

clicks = normal.unionByName(power).withColumn("score", F.col("ad_id") % 13)

# The fix: at most 3 ads per user on each side, so the join can produce at most
# 3 * 3 = 9 rows per user instead of N * N.
window = Window.partitionBy("mid").orderBy(F.col("score").desc(), F.col("ad_id").asc())
trimmed = clicks.withColumn("rn", F.row_number().over(window)).where(F.col("rn") <= 3).drop("rn")

a = trimmed.alias("a")
b = trimmed.alias("b")
pairs = (
    a.join(b, F.col("a.mid") == F.col("b.mid"))
    .where(F.col("a.ad_id") < F.col("b.ad_id"))
    .select(F.col("a.mid").alias("mid"), F.col("a.ad_id").alias("ad_a"), F.col("b.ad_id").alias("ad_b"))
)

window2 = Window.partitionBy("mid").orderBy(F.col("ad_b").desc())
ranked = pairs.withColumn("rn", F.row_number().over(window2)).where(F.col("rn") <= 20)
ranked.write.mode("overwrite").parquet(os.environ.get("SPARK_OUT_DIR", "/tmp/sparksleuth-j7"))

print(f"rows written: {spark.read.parquet(os.environ.get('SPARK_OUT_DIR', '/tmp/sparksleuth-j7')).count()}")
spark.stop()
