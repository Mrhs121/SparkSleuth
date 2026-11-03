import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/skills/registry.js';
import { ArtifactStore } from '../src/artifacts/store.js';
import { loadConfig } from '../src/config.js';
import type { AgentEvent, LLMResponse, Skill } from '../src/types.js';

test('Agent loop runs a turn with tool calling and generates an artifact on large output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sparksleuth-loop-'));
  try {
    const config = loadConfig({
      runtime: {
        maxSteps: 5,
        maxToolResultChars: 100, // Small limit to trigger artifact truncation
      },
    });

    const testSkill: Skill = {
      name: 'tester',
      description: 'A test skill',
      detail: () => 'Test skill details',
      tools: () => [
        {
          name: 'large_data',
          description: 'Returns large text',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => ({
            summary: 'X'.repeat(500),
          }),
        },
      ],
    };

    const registry = new ToolRegistry([testSkill], { config });
    const artifacts = new ArtifactStore(join(dir, 'artifacts'));

    let callCount = 0;
    const fakeLLM = {
      async complete(): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) {
          // Model decides to call tester_large_data
          return {
            blocks: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'tester_large_data',
                input: {},
              },
            ],
            usage: { input: 10, output: 5 },
          };
        }
        // Model provides final answer
        return {
          blocks: [{ type: 'text', text: 'Diagnosis complete.' }],
          usage: { input: 20, output: 8 },
        };
      },
    } as any;

    const agent = new Agent(fakeLLM, registry, config);
    const events: AgentEvent[] = [];

    const result = await agent.run({
      system: 'You are an agent',
      messages: [{ role: 'user', content: 'check test data' }],
      artifacts,
      sessionId: 'test_session',
      emit: (e) => events.push(e),
    });

    assert.equal(result.reason, 'end_turn');
    assert.equal(callCount, 2);

    // Verify tool_result event was emitted and got truncated into an artifact
    const toolResultEvent = events.find((e) => e.type === 'tool_result');
    assert.ok(toolResultEvent);
    if (toolResultEvent && toolResultEvent.type === 'tool_result') {
      assert.ok(toolResultEvent.artifact);
      assert.ok(toolResultEvent.summary.includes('Full result saved as artifact'));
    }

    // Verify artifact file actually exists and holds the content
    const artifactList = await artifacts.list();
    assert.equal(artifactList.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
