import type { Config } from '../config.js';
import type { ContentBlock, Message, Usage } from '../types.js';

export interface LLMToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMCallbacks {
  onTextDelta?(text: string): void;
  onThinkingDelta?(text: string): void;
  onToolUseStart?(id: string, name: string): void;
}

export interface LLMResult {
  blocks: ContentBlock[];
  stopReason: string;
  usage: Usage;
}

interface StreamState {
  blocks: Map<number, ContentBlock & { _json?: string }>;
  stopReason: string;
  usage: Usage;
}

/**
 * Minimal client for the Anthropic Messages protocol (streaming + tool use).
 * Works against api.anthropic.com and any compatible gateway.
 */
export class LLMClient {
  constructor(private readonly cfg: Config['llm']) {}

  async complete(
    params: { system: string; messages: Message[]; tools: LLMToolSchema[]; signal?: AbortSignal },
    cb: LLMCallbacks = {},
  ): Promise<LLMResult> {
    const body = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      stream: true,
      system: [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }],
      messages: toApiMessages(params.messages),
      ...(params.tools.length ? { tools: params.tools } : {}),
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      let emitted = false;
      try {
        return await this.streamOnce(body, params.signal, {
          ...cb,
          onTextDelta: (t) => {
            emitted = true;
            cb.onTextDelta?.(t);
          },
        });
      } catch (err) {
        lastErr = err;
        if (params.signal?.aborted) throw err;
        // Never replay a partially emitted answer: the user would see it twice.
        if (emitted) throw err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  private async streamOnce(
    body: unknown,
    signal: AbortSignal | undefined,
    cb: LLMCallbacks,
  ): Promise<LLMResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('model timeout')), this.cfg.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(`${this.cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': this.cfg.apiKey,
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`model gateway returned ${res.status}: ${redact(text).slice(0, 400)}`);
      }

      return await this.consume(res.body, cb);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async consume(
    stream: ReadableStream<Uint8Array>,
    cb: LLMCallbacks,
  ): Promise<LLMResult> {
    const state: StreamState = { blocks: new Map(), stopReason: 'end_turn', usage: { input: 0, output: 0 } };
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let evt: any;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          this.handleEvent(evt, state, cb);
        }
      }
    }

    const blocks: ContentBlock[] = [];
    for (const [, b] of [...state.blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (b.type === 'tool_use') {
        const { _json, ...rest } = b as any;
        let input: Record<string, unknown> = (rest.input as Record<string, unknown>) ?? {};
        if (_json) {
          try {
            input = JSON.parse(_json);
          } catch {
            input = { _raw: _json };
          }
        }
        blocks.push({ ...rest, input });
      } else {
        const { _json, ...rest } = b as any;
        if (rest.type === 'thinking' && !rest.thinking) continue;
        if (rest.type === 'text' && !rest.text) continue;
        blocks.push(rest as ContentBlock);
      }
    }
    return { blocks, stopReason: state.stopReason, usage: state.usage };
  }

  private handleEvent(evt: any, state: StreamState, cb: LLMCallbacks): void {
    switch (evt.type) {
      case 'message_start': {
        const u = evt.message?.usage;
        if (u) state.usage.input = u.input_tokens ?? 0;
        break;
      }
      case 'content_block_start': {
        const b = evt.content_block;
        if (!b) break;
        if (b.type === 'tool_use') {
          state.blocks.set(evt.index, { type: 'tool_use', id: b.id, name: b.name, input: {} } as any);
          cb.onToolUseStart?.(b.id, b.name);
        } else if (b.type === 'thinking') {
          state.blocks.set(evt.index, { type: 'thinking', thinking: '', signature: b.signature } as any);
        } else if (b.type === 'text') {
          state.blocks.set(evt.index, { type: 'text', text: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const b = state.blocks.get(evt.index) as any;
        if (!b) break;
        const d = evt.delta;
        if (d?.type === 'text_delta') {
          b.text = (b.text ?? '') + d.text;
          cb.onTextDelta?.(d.text);
        } else if (d?.type === 'thinking_delta') {
          b.thinking = (b.thinking ?? '') + d.thinking;
          cb.onThinkingDelta?.(d.thinking);
        } else if (d?.type === 'signature_delta') {
          b.signature = (b.signature ?? '') + d.signature;
        } else if (d?.type === 'input_json_delta') {
          b._json = (b._json ?? '') + d.partial_json;
        }
        break;
      }
      case 'message_delta': {
        if (evt.delta?.stop_reason) state.stopReason = evt.delta.stop_reason;
        if (evt.usage) state.usage.output = evt.usage.output_tokens ?? state.usage.output;
        break;
      }
      case 'error': {
        throw new Error(`model stream error: ${evt.error?.message ?? JSON.stringify(evt)}`);
      }
      default:
        break;
    }
  }
}

/**
 * Convert our message list into the wire format.
 * Thinking blocks without a signature are dropped: gateways reject them on replay.
 */
function toApiMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const content = m.content
      .filter((b) => {
        if (b.type === 'thinking') return Boolean(b.signature);
        if (b.type === 'text') return b.text.trim().length > 0;
        return true;
      })
      .map((b) => {
        if (b.type === 'tool_result') {
          return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) };
        }
        return b;
      });
    return { role: m.role, content };
  });
}

function redact(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[^\s"]+/gi, 'Bearer ***')
    .replace(/"(api[_-]?key|token|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
}
