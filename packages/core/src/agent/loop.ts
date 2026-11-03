import type { ArtifactStore } from '../artifacts/store.js';
import type { Config } from '../config.js';
import { LLMClient } from '../llm/client.js';
import type { ToolRegistry } from '../skills/registry.js';
import type { AgentEvent, ContentBlock, Message, ToolResult, Usage } from '../types.js';
import { truncate } from '../util/format.js';

export interface RunParams {
  system: string;
  messages: Message[];
  artifacts: ArtifactStore;
  sessionId: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
  maxSteps?: number;
}

export interface RunResult {
  messages: Message[];
  reason: 'end_turn' | 'max_steps' | 'aborted';
  usage: Usage;
}

/**
 * The ReAct loop: model decides, tools run, results come back, repeat.
 * Deliberately small and explicit so the whole control flow stays auditable.
 */
export class Agent {
  constructor(
    private readonly llm: LLMClient,
    private readonly registry: ToolRegistry,
    private readonly config: Config,
  ) {}

  async run(params: RunParams): Promise<RunResult> {
    const { system, artifacts, sessionId, emit, signal } = params;
    const messages: Message[] = [...params.messages];
    const maxSteps = params.maxSteps ?? this.config.runtime.maxSteps;
    const usage: Usage = { input: 0, output: 0 };

    for (let step = 1; step <= maxSteps; step++) {
      if (signal?.aborted) return { messages, reason: 'aborted', usage };
      emit({ type: 'step_start', step });

      // Near the step budget, tell the model to land the plane instead of
      // letting the run die mid-investigation without a report.
      const remaining = maxSteps - step;
      if (remaining === 2) {
        messages.push({
          role: 'user',
          content:
            'You have two steps left. Stop investigating unless something is still contradictory, and write the final report now with session_save_report.',
        });
      }

      const res = await this.llm.complete(
        { system, messages, tools: this.registry.schemas(), signal },
        {
          onTextDelta: (text) => emit({ type: 'text_delta', text }),
          onThinkingDelta: (text) => emit({ type: 'thinking_delta', text }),
        },
      );

      usage.input += res.usage.input;
      usage.output += res.usage.output;
      emit({ type: 'usage', usage: { ...usage } });

      messages.push({ role: 'assistant', content: res.blocks });

      const toolCalls = res.blocks.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );

      if (toolCalls.length === 0) {
        return { messages, reason: 'end_turn', usage };
      }

      for (const call of toolCalls) {
        const [skill, ...rest] = call.name.split('_');
        emit({
          type: 'tool_use',
          id: call.id,
          skill: this.registry.list().find((t) => t.fullName === call.name)?.skill ?? skill,
          tool: rest.join('_') || call.name,
          input: call.input,
        });
      }

      const results = await this.runTools(toolCalls, {
        artifacts,
        sessionId,
        signal,
        emit,
      });

      messages.push({ role: 'user', content: results });
    }

    return { messages, reason: 'max_steps', usage };
  }

  private async runTools(
    calls: Array<Extract<ContentBlock, { type: 'tool_use' }>>,
    ctx: { artifacts: ArtifactStore; sessionId: string; signal?: AbortSignal; emit: (e: AgentEvent) => void },
  ): Promise<ContentBlock[]> {
    const { artifacts, sessionId, signal, emit } = ctx;
    const limit = Math.max(1, this.config.runtime.toolConcurrency);
    const out: ContentBlock[] = new Array(calls.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < calls.length) {
        const i = cursor++;
        const call = calls[i];
        const result = await this.invoke(call, { artifacts, sessionId, signal });
        const entry = this.registry.list().find((t) => t.fullName === call.name);
        emit({
          type: 'tool_result',
          id: call.id,
          skill: entry?.skill ?? call.name.split('_')[0],
          tool: call.name.replace(`${entry?.skill ?? ''}_`, ''),
          summary: result.summary,
          isError: result.isError,
          artifact: result.artifact,
        });
        out[i] = {
          type: 'tool_result',
          tool_use_id: call.id,
          content: result.summary,
          ...(result.isError ? { is_error: true } : {}),
        };
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, calls.length) }, worker));
    return out;
  }

  private async invoke(
    call: Extract<ContentBlock, { type: 'tool_use' }>,
    ctx: { artifacts: ArtifactStore; sessionId: string; signal?: AbortSignal },
  ): Promise<ToolResult> {
    const { artifacts, sessionId, signal } = ctx;
    const timeout = AbortSignal.timeout(this.config.runtime.toolTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let result: ToolResult;
    try {
      result = await this.registry.execute(call.name, call.input, {
        sessionId,
        artifacts,
        config: this.config,
        signal: combined,
      });
    } catch (err) {
      result = {
        summary: `Tool threw: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    // Hard cap on what enters the context. Anything larger becomes an artifact.
    const max = this.config.runtime.maxToolResultChars;
    if (result.summary.length > max && !result.isError) {
      const stored = await artifacts.write(call.name, { text: result.summary });
      result = {
        ...result,
        artifact: result.artifact ?? stored.id,
        summary: `${truncate(result.summary, max)}\n\n[Full result saved as artifact ${stored.id}. Use core_artifact_query to read specific parts.]`,
      };
    }
    return result;
  }
}
