# Diagnostic rules

Rules run inside the `spark-diagnose` skill. Each rule reads data collected by
`spark-history`, compares it against a threshold, and emits a finding with the
evidence attached.

A rule never guesses. If the data it needs is missing, it stays silent.

## Finding shape

```json
{
  "ruleId": "SPILL_HEAVY",
  "severity": "P0",
  "scope": { "stageId": 5 },
  "title": "Stage 5 spilled 13.6 TB to memory",
  "evidence": { "memorySpillBytes": 14953358137753, "spillRatio": 3.2 },
  "possibleCauses": ["join fan-out", "too few partitions"],
  "suggestions": ["pre-aggregate before the join", "raise shuffle partitions"]
}
```

Severity means: **P0** likely the main cause, fix first; **P1** significant,
address in the same change; **P2** worth knowing, not urgent.

## Rules

### `STAGE_DOMINANT` — one stage eats the wall clock

- **Fires when** a single stage accounts for more than 50% of total job duration.
- **Why it matters** the rest of the investigation should focus there.
- **Default threshold** `dominantRatio = 0.5`

### `SPILL_HEAVY` — spilling to disk

- **Fires when** memory spill exceeds shuffle read, or disk spill exceeds 1 GB.
- **Why it matters** spill means the working set does not fit; every spilled byte is extra I/O.
- **Thresholds** `spillRatio > 1`, `diskSpill > 1 GiB`

### `TASK_SKEW` — a few tasks do all the work

- **Fires when** max task duration is more than 5× p50 and exceeds 5 s.
- **Why it matters** the stage ends when its slowest task ends; the rest of the cluster idles.
- **Thresholds** `durationSkewRatio > 5`; `P1` above 5 s, `P0` above 60 s — a long tail under five seconds rarely changes the outcome, but it is still worth naming.

### `SHUFFLE_SKEW` — uneven shuffle read

- **Fires when** max shuffle-read bytes exceed 5× p50 and the largest shard exceeds 1 MB.
- **Why it matters** points at a hot key rather than a slow node.
- **Thresholds** `shuffleReadSkewRatio > 5`; `P2` under 100 MB, `P1` above it.

### `JOIN_EXPLOSION` — row fan-out in a join

- **Fires when** a join's output row count exceeds its largest input by more than 10×.
- **Why it matters** usually means the join key is not unique — many-to-many instead of one-to-many.
- **Threshold** `fanoutRatio > 10`

### `BNLJ` — broadcast nested loop join

- **Fires when** the physical plan contains a broadcast nested loop join or a cartesian product.
- **Why it matters** it is O(n×m); on large inputs it is nearly always the bottleneck.
- **Threshold** any occurrence

### `SMJ_BROADCASTABLE` — a small side shuffled needlessly

- **Fires when** a sort-merge join has one side well under the broadcast threshold, and the join key is wrapped in an expression that defeats broadcast detection.
- **Why it matters** an expression-based join key also disables partition pruning and statistics.
- **Threshold** `smallSide < broadcastThreshold × 10`

### `GC_HEAVY` — the JVM spends its time collecting

- **Fires when** GC time exceeds 10% of task time, at executor level or in a stage whose median task runs longer than 10 s with at least 1 s of GC.
- **Why it matters** object churn, oversized partitions, or a heap that is too small.
- **Threshold** `gcRatio > 0.10`. Short stages are ignored: a few hundred milliseconds of GC inside a sub-second task is noise, and reporting it trains people to ignore the rule.

### `EXECUTOR_LOST` — executors disappearing

- **Fires when** executors are removed for reasons other than normal dynamic-allocation scale-down.
- **Why it matters** churn means retried work and unstable stages.
- **Signals** removal reasons grouped by exit status: OOM, container killed, node lost.

### `TASK_FAILURES` — retries and failures

- **Fires when** any task or stage failed and was retried.
- **Why it matters** failure reasons cluster, and the cluster usually names the cause.
- **Signals** normalized failure messages (digits and IDs stripped) grouped by count.

### `SMALL_FILES` — too many tiny files

- **Fires when** a scan reads many files with a small average size.
- **Why it matters** per-file overhead dominates, and the problem compounds downstream.
- **Thresholds** `fileCount > 1000`, `avgFileSize < 16 MiB`; `P1` above 5000 files.

### `CONF_CHECK` — risky configuration

- **Fires when** settings that commonly cause trouble are found.
- **Checks** AQE off, adaptive skew join off, executor memory/overhead ratio out of range, shuffle partitions wildly mismatched to data size.

## Adding a rule

1. Create `packages/skills-spark/src/rules/<id>.ts` exporting a `Rule`.
2. Declare the data it needs (`requires`) so the collector fetches only that.
3. Return `null` when the data does not support a conclusion.
4. Add a fixture under `testenv/` that triggers it, and register the expected
   rule set in the regression test.
