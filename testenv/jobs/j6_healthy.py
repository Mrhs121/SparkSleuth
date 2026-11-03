"""A well-behaved job. The rules must stay quiet on this one."""
import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = (
    SparkSession.builder.appName("j6_healthy")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .config("spark.sql.shuffle.partitions", "16")
    .getOrCreate()
)

fact = spark.range(0, 1_000_000).withColumn("k", (F.col("id") % 500).cast("int")).withColumn("v", (F.col("id") % 100).cast("int"))
dim = spark.range(0, 500).withColumn("label", F.concat(F.lit("k-"), F.col("id").cast("string")))

result = fact.join(F.broadcast(dim), F.col("k") == dim["id"]).groupBy("label").agg(F.sum("v").alias("total"))
result.write.mode("overwrite").parquet(os.environ.get("SPARK_OUT_DIR", "/tmp/sparksleuth-j6"))
print(f"labels: {spark.read.parquet(os.environ.get('SPARK_OUT_DIR', '/tmp/sparksleuth-j6')).count()}")
spark.stop()
