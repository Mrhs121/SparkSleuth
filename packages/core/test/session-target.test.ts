import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSkill, parseSessionGraphTarget } from '../src/skills/session.js';

test('graph references require explicit app and valid scope-specific IDs', () => {
  assert.deepEqual(parseSessionGraphTarget({ scope: 'node', appId: 'local-1', sqlId: 0, nodeId: 0 }),
    { scope: 'node', appId: 'local-1', sqlId: 0, nodeId: 0 });
  for (const value of [null, { scope: 'node', appId: 'x', sqlId: 0 },
    { scope: 'stage', appId: 'x', stageId: -1 }, { scope: 'sql', appId: 'x', sqlId: '2' },
    { scope: 'unknown', appId: 'x' }, { scope: 'application', appId: '' }]) {
    assert.equal(parseSessionGraphTarget(value), undefined);
  }
});

test('milestone hook retains explicit graph target but ignores invalid target', async () => {
  const seen: unknown[] = [];
  const skill = createSessionSkill({
    async markPurpose() {}, async reportFinding(payload) { seen.push(payload); },
    async saveReport() { return { path: 'report.md' }; },
  });
  const tools = await skill.tools({} as never);
  const finding = tools.find((t) => t.name === 'report_finding')!;
  await finding.execute({ stage: 'Plan', finding: 'BNLJ', target: { scope: 'node', appId: 'a', sqlId: 1, nodeId: 3 } }, {} as never);
  await finding.execute({ stage: 'Plan', finding: 'unknown', target: { scope: 'node', appId: 'a' } }, {} as never);
  assert.deepEqual((seen[0] as { target: unknown }).target, { scope: 'node', appId: 'a', sqlId: 1, nodeId: 3 });
  assert.equal((seen[1] as { target: unknown }).target, undefined);
});
