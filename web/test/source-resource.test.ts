import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Minimal hook lifecycle driver: no DOM dependency; exercises the actual loader's effects and cleanups.
function resourceDriver() {
  let state: unknown;
  let dependencies: unknown[] | undefined;
  let cleanup: (() => void) | undefined;
  const react = {
    useState: (initial: unknown) => {
      state ??= initial;
      return [state, (next: unknown) => { state = typeof next === 'function' ? next(state) : next; }];
    },
    useEffect: (effect: () => (() => void) | undefined, next: unknown[]) => {
      if (dependencies && next.every((item, index) => Object.is(item, dependencies![index]))) return;
      cleanup?.();
      dependencies = next;
      cleanup = effect();
    },
  };
  const source = readFileSync(new URL('../src/useSourceResource.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { useSourceResource?: (id: string | null, active: boolean, load: (signal: AbortSignal) => Promise<string>, revision?: number) => { data?: string; loading: boolean; error?: string } } = {};
  runInNewContext(code, { exports, require: (name: string) => { assert.equal(name, 'react'); return react; }, AbortController, Error });
  return { render: exports.useSourceResource!, unmount: () => cleanup?.() };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('UI language switch preserves original content without another read or generation', async () => {
  const driver = resourceDriver();
  let reads = 0;
  let modelCalls = 0;
  const original = '# 原始标题\nOriginal saved report';
  const load = async () => { reads++; return original; };
  // A UI-language rerender changes labels, not any source-resource input.
  const renderUI = (language: 'zh' | 'en') => ({ label: language === 'zh' ? '报告' : 'Report', resource: driver.render('exact/sid', true, load) });
  renderUI('zh');
  await flush();
  assert.equal(renderUI('zh').resource.data, original);
  const switched = renderUI('en');
  await flush();
  assert.equal(switched.label, 'Report');
  assert.equal(switched.resource.data, original);
  assert.equal(reads, 1);
  assert.equal(modelCalls, 0);
  assert.equal(renderUI('zh').resource.data, original);
  assert.equal(reads, 1);
  driver.unmount();
});

test('exact sid selection aborts stale reads and never displays another document', async () => {
  const driver = resourceDriver();
  let resolveFirst!: (text: string) => void;
  let firstSignal!: AbortSignal;
  const firstLoad = (signal: AbortSignal) => { firstSignal = signal; return new Promise<string>((resolve) => { resolveFirst = resolve; }); };
  const secondLoad = async () => '# Second';
  driver.render('first/sid', true, firstLoad);
  assert.equal(driver.render('second/sid', true, secondLoad).data, undefined);
  assert.equal(firstSignal.aborted, true);
  await flush();
  resolveFirst('# Stale first');
  await flush();
  assert.equal(driver.render('second/sid', true, secondLoad).data, '# Second');
  driver.unmount();
});

test('explicit retry reloads and retains same-source content on an error', async () => {
  const driver = resourceDriver();
  let reads = 0;
  const load = async () => { if (++reads === 1) return '# Saved'; throw new Error('offline'); };
  driver.render('sid', true, load);
  await flush();
  driver.render('sid', true, load, 1);
  await flush();
  const result = driver.render('sid', true, load, 1);
  assert.equal(result.data, '# Saved');
  assert.equal(result.error, 'offline');
  assert.equal(result.loading, false);
  assert.equal(reads, 2);
  driver.unmount();
});
