"""A self join that explodes: the classic many-to-many fan-out.

A few power users click thousands of ads, so joining the click table to itself
on user id produces N*N rows per user. Small input, huge intermediate.
"""
import os

from pyspark.sql import SparkSession
from pyspark.sql import Window
from pyspark.sql import functions as F

spark = (
    SparkSession.builder.appName("j1_self_join_explosion")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .config("spark.sql.shuffle.partitions", "32")
    .getOrCreate()
)

# 200k ordinary users with 16 ads each.
normal = (
    spark.range(0, 200_000)
    .withColumn("mid", F.col("id"))
    .withColumn("ad_id", F.explode(F.array([F.lit(i) for i in range(16)])))
    .select("mid", "ad_id")
)

# 3 power users with 6000 ads each: ~18M rows per user after the join.
power = (
    spark.range(0, 3)
    .withColumn("mid", F.col("id") + 900_000)
    .withColumn("ad_id", F.explode(F.array([F.lit(i) for i in range(6000)])))
    .select("mid", "ad_id")
)

clicks = normal.unionByName(power).withColumn("click", F.lit(1)).withColumn("conv", F.col("ad_id") % 7)

a = clicks.alias("a")
b = clicks.alias("b")
pairs = a.join(b, F.col("a.mid") == F.col("b.mid")).where(F.col("a.ad_id") < F.col("b.ad_id")).select(
    F.col("a.mid").alias("mid"), F.col("a.ad_id").alias("ad_a"), F.col("b.ad_id").alias("ad_b")
)

# Rank each user's pairs. Sorting the whole join output is what a real pipeline
# does before a Top-N, and it is where the fan-out turns into memory pressure.
window = Window.partitionBy("mid").orderBy(F.col("ad_b").desc())
ranked = pairs.withColumn("rn", F.row_number().over(window)).where(F.col("rn") <= 200)
ranked.write.mode("overwrite").parquet(os.environ.get("SPARK_OUT_DIR", "/tmp/sparksleuth-j1"))

print(f"rows written: {spark.read.parquet(os.environ.get('SPARK_OUT_DIR', '/tmp/sparksleuth-j1')).count()}")
spark.stop()
