"""A non-equi join: the optimizer can only do a broadcast nested loop join."""
import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = (
    SparkSession.builder.appName("j3_bnlj")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .config("spark.sql.adaptive.enabled", "false")
    .getOrCreate()
)

events = spark.range(0, 400_000).withColumn("path", F.concat(F.lit("/api/service/v"), (F.col("id") % 10).cast("string"), F.lit("/item")))
routes = spark.range(0, 300).withColumn("prefix", F.concat(F.lit("/api/service/v"), (F.col("id") % 10).cast("string")))

# Range predicate on a string: not an equi-join, so BNLJ is the only option.
matched = events.join(routes, events["path"].startswith(routes["prefix"]))
agg = matched.groupBy("prefix").agg(F.count(F.lit(1)).alias("hits"))

agg.write.mode("overwrite").parquet(os.environ.get("SPARK_OUT_DIR", "/tmp/sparksleuth-j3"))
print(f"routes: {spark.read.parquet(os.environ.get('SPARK_OUT_DIR', '/tmp/sparksleuth-j3')).count()}")
spark.stop()
