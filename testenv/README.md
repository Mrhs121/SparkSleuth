# testenv

A throwaway Spark History Server plus a set of deliberately broken jobs, so the
rule engine and the agent can be exercised without touching a real cluster.

```bash
./testenv/start-hs.sh          # History Server on http://localhost:18080
./testenv/run-all.sh           # submit every job in testenv/jobs
./testenv/stop-hs.sh
```

`SPARK_HOME` must point at a Spark 3.5 distribution. Jobs run in `local[4]` with a
1 GB driver — find a real cluster with `SPARK_MASTER='local-cluster[2,2,1024]'`.

Each job exists to trip exactly one rule, and every rule must stay quiet on the
two healthy jobs. That is the regression contract:

| Job | What it does | Rules expected |
|---|---|---|
| `j1_self_join_explosion` | self-joins a click table on a non-unique key, exploding 3.2M rows to 78M | `JOIN_EXPLOSION`, `SPILL_HEAVY` |
| `j2_skew_join` | one hot join key, AQE off | `SHUFFLE_SKEW`, `CONF_CHECK` |
| `j3_bnlj` | non-equi join that falls back to a broadcast nested loop | `BNLJ` |
| `j4_small_files` | writes 2000 tiny files, then scans them | `SMALL_FILES` |
| `j5_task_failures` | deliberately throws inside the tasks | `TASK_FAILURES` |
| `j6_healthy` | a well-behaved job | *none* |
| `j7_self_join_optimized` | j1 with the fan-out capped at 3 ads per user | *none* |
| `j8_smj_broadcastable` | Sort-merge join on tiny dimension table (< 50 KB) that should be broadcast | `SMJ_BROADCASTABLE` |
| `j9_straggler_skew` | Extreme key skew where one task straggles and takes > 5s | `TASK_SKEW`, `SHUFFLE_SKEW`, `CONF_CHECK` |
| `j10_stage_dominant` | Multi-stage pipeline where a single stage takes > 30s and dominates total latency | `STAGE_DOMINANT` |

j1 and j7 are a before/after pair: same data, same question, opposite verdict.

Verify the current History Server contents in one shot:

```bash
pnpm --filter @sparksleuth/skills-spark exec tsx scripts/verify-fixtures.ts
```

```
j1_self_join_explosion         33s  P0:SPILL_HEAVY P0:SPILL_HEAVY P0:JOIN_EXPLOSION
j2_skew_join                    8s  P0:SPILL_HEAVY P2:SHUFFLE_SKEW P2:CONF_CHECK
j3_bnlj                         7s  P1:BNLJ P2:CONF_CHECK
j4_small_files                 22s  P2:SMALL_FILES
j5_task_failures                5s  P0:TASK_FAILURES
j6_healthy                      9s  (no findings)
j7_self_join_optimized         14s  (no findings)
j8_smj_broadcastable            9s  P2:SMJ_BROADCASTABLE
j9_straggler_skew              14s  P1:TASK_SKEW P2:SHUFFLE_SKEW P2:CONF_CHECK
j10_stage_dominant             38s  P1:STAGE_DOMINANT
```

## Notes

- Jobs bind the driver to `127.0.0.1`. Without that, `spark-submit` fails with
  `Can't assign requested address: Service 'sparkDriver' failed after 16 retries`
  on machines whose hostname does not resolve.
- `--driver-memory 512m` exits with code 52 (the JVM is killed) rather than
  reporting an error. Use 1 GB or more.
- Event logs land in `/tmp/spark-events`; delete that directory to start clean.
