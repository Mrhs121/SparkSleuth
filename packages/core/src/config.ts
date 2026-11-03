export interface Config {
  auth: {
    token: string;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
  };
  spark: {
    historyServerUrl: string;
  };
  runtime: {
    port: number;
    dataDir: string;
    maxSteps: number;
    contextBudgetTokens: number;
    maxToolResultChars: number;
    sessionTimeoutMs: number;
    concurrency: number;
    toolTimeoutMs: number;
    toolConcurrency: number;
  };
  rules: Record<string, number>;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return fallback;
  }
  return v;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    auth: {
      token: env('SPARKSLEUTH_TOKEN', ''),
    },
    llm: {
      baseUrl: env('SPARKSLEUTH_LLM_BASE_URL', 'https://api.anthropic.com').replace(/\/+$/, ''),
      apiKey: env('SPARKSLEUTH_LLM_API_KEY', ''),
      model: env('SPARKSLEUTH_LLM_MODEL', 'claude-sonnet-4-5'),
      maxTokens: intEnv('SPARKSLEUTH_LLM_MAX_TOKENS', 8192),
      timeoutMs: intEnv('SPARKSLEUTH_LLM_TIMEOUT_MS', 300_000),
    },
    spark: {
      historyServerUrl: env('SPARKSLEUTH_HS_URL', 'http://localhost:18080').replace(/\/+$/, ''),
    },
    runtime: {
      port: intEnv('SPARKSLEUTH_PORT', 8787),
      dataDir: env('SPARKSLEUTH_DATA_DIR', './data'),
      maxSteps: intEnv('SPARKSLEUTH_MAX_STEPS', 30),
      contextBudgetTokens: intEnv('SPARKSLEUTH_CONTEXT_BUDGET', 120_000),
      maxToolResultChars: intEnv('SPARKSLEUTH_MAX_TOOL_RESULT_CHARS', 6000),
      sessionTimeoutMs: intEnv('SPARKSLEUTH_SESSION_TIMEOUT_MS', 1_200_000),
      concurrency: intEnv('SPARKSLEUTH_CONCURRENCY', 3),
      toolTimeoutMs: intEnv('SPARKSLEUTH_TOOL_TIMEOUT_MS', 120_000),
      toolConcurrency: intEnv('SPARKSLEUTH_TOOL_CONCURRENCY', 4),
    },
    rules: {
      skewRatio: Number(env('SPARKSLEUTH_RULE_SKEW_RATIO', '5')),
      spillRatio: Number(env('SPARKSLEUTH_RULE_SPILL_RATIO', '1')),
      gcRatio: Number(env('SPARKSLEUTH_RULE_GC_RATIO', '0.1')),
      fanoutRatio: Number(env('SPARKSLEUTH_RULE_FANOUT_RATIO', '10')),
      dominantRatio: Number(env('SPARKSLEUTH_RULE_DOMINANT_RATIO', '0.5')),
    },
  };
  return deepMerge(cfg, overrides) as Config;
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object') {
      out[k] = deepMerge(cur, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}
