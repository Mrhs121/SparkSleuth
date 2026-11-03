/** Content blocks mirror the Anthropic Messages API shape. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolResult {
  /** Compact, human readable result. This is what the model sees. */
  summary: string;
  /** Optional artifact id holding the full payload. */
  artifact?: string;
  isError?: boolean;
}

export interface ToolContext {
  sessionId: string;
  signal?: AbortSignal;
  artifacts: import('./artifacts/store.js').ArtifactStore;
  config: import('./config.js').Config;
}

export interface ToolDefinition {
  /** Tool name without the skill prefix. snake_case. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface Skill {
  /** Short id, lowercase. Used as the tool name prefix. */
  name: string;
  /** One line description shown to the model at all times. */
  description: string;
  /** When and how to use this skill. Loaded on demand via skill_load. */
  detail(): string | Promise<string>;
  tools(): ToolDefinition[];
}

export interface Usage {
  input: number;
  output: number;
}

export type AgentEvent =
  | { type: 'step_start'; step: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; id: string; skill: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; skill: string; tool: string; summary: string; isError?: boolean; artifact?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; reason: 'end_turn' | 'max_steps' | 'aborted'; usage: Usage }
  | { type: 'error'; message: string };
