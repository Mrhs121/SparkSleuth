"""A UDF that fails on a predictable subset of rows, forcing task retries."""
import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import IntegerType

spark = (
    SparkSession.builder.appName("j5_task_failures")
    .config("spark.eventLog.enabled", "true")
    .config("spark.eventLog.dir", os.environ.get("SPARK_EVENT_LOG_DIR", "file:/tmp/spark-events"))
    .config("spark.task.maxFailures", "2")
    .getOrCreate()
)


def risky(value: int) -> int:
    if value % 5000 == 0:
        raise ValueError(f"bad record in partition handling value {value}: upstream column missing")
    return value * 2


risky_udf = F.udf(risky, IntegerType())

# The write triggers evaluation; retries exhaust and the application fails.
(
    spark.range(0, 200_000)
    .select(risky_udf("id").alias("doubled"))
    .write.mode("overwrite")
    .parquet(os.environ.get("SPARK_OUT_DIR", "/tmp/sparksleuth-j5"))
)

spark.stop()
