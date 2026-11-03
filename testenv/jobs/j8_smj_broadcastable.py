"""A sort-merge join where one side is a tiny dimension table that should be broadcast.

Forces SortMergeJoin on a tiny lookup table (< 50 KB) against a multi-million
row fact table. The engine needlessly shuffles and sorts both tables instead
of performing a simple BroadcastHashJoin.
"""
import os
import shutil

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

TMP_DIR = os.environ.get("SPARK_OUT_DIR", "/tmp/sparksleuth-j8")
FACTS_PATH = f"{TMP_DIR}/facts"
DIM_PATH = f"{TMP_DIR}/dim"

# Clean up previous runs
shutil.rmtree(TMP_DIR, ignore_errors=True)

spark = (
    SparkSession.builder.appName("j8_smj_broadcastable")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .config("spark.sql.autoBroadcastJoinThreshold", "-1")  # Disable broadcast to force SMJ
    .config("spark.sql.join.preferSortMergeJoin", "true")
    .config("spark.sql.shuffle.partitions", "16")
    .getOrCreate()
)

# 1. Prepare tiny dimension table (~10 rows, a few KB)
dim = (
    spark.range(0, 10)
    .withColumn("category_id", F.col("id"))
    .withColumn("category_name", F.concat(F.lit("Category_"), F.col("id")))
    .drop("id")
)
dim.write.mode("overwrite").parquet(DIM_PATH)

# 2. Prepare larger facts table (1,500,000 rows)
facts = (
    spark.range(0, 1_500_000)
    .withColumn("category_id", F.col("id") % 10)
    .withColumn("amount", (F.col("id") % 100).cast("double"))
)
facts.write.mode("overwrite").parquet(FACTS_PATH)

# 3. Read both from parquet so scan metrics (size of files) are populated
dim_df = spark.read.parquet(DIM_PATH)
facts_df = spark.read.parquet(FACTS_PATH)

# 4. Join and aggregate - forces SortMergeJoin
joined = facts_df.hint("merge").join(dim_df, "category_id")
result = joined.groupBy("category_name").agg(
    F.count("*").alias("total_records"),
    F.sum("amount").alias("total_amount")
)

OUT_PATH = f"{TMP_DIR}/out"
result.write.mode("overwrite").parquet(OUT_PATH)

print(f"j8 finished. Records: {spark.read.parquet(OUT_PATH).count()}")
spark.stop()
