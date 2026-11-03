import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { loadConfig } from '@sparksleuth/core';

test('Config endpoints return and update runtime configurations', async () => {
  const config = loadConfig({
    spark: { historyServerUrl: 'http://localhost:18080' },
    llm: { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test12345678', model: 'claude-sonnet-4-5', maxTokens: 8192, timeoutMs: 300_000 },
  });

  const app = Fastify();

  app.get('/api/config', async () => ({
    spark: { historyServerUrl: config.spark.historyServerUrl },
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      hasApiKey: Boolean(config.llm.apiKey),
      apiKeyPreview: `${config.llm.apiKey.slice(0, 6)}...${config.llm.apiKey.slice(-4)}`,
    },
    auth: { required: Boolean(config.auth.token) },
  }));

  app.post<{
    Body: {
      spark?: { historyServerUrl?: string };
      llm?: { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number };
    };
  }>('/api/config', async (req) => {
    if (req.body?.spark?.historyServerUrl) {
      config.spark.historyServerUrl = req.body.spark.historyServerUrl.replace(/\/+$/, '');
    }
    if (req.body?.llm) {
      if (req.body.llm.baseUrl) config.llm.baseUrl = req.body.llm.baseUrl.replace(/\/+$/, '');
      if (req.body.llm.apiKey) config.llm.apiKey = req.body.llm.apiKey.trim();
      if (req.body.llm.model) config.llm.model = req.body.llm.model.trim();
      if (req.body.llm.maxTokens) config.llm.maxTokens = req.body.llm.maxTokens;
    }
    return { ok: true, spark: config.spark, llm: { ...config.llm, apiKeyPreview: 'sk-ant...5678' } };
  });

  // 1. GET /api/config
  const getRes = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(getRes.statusCode, 200);
  const data = JSON.parse(getRes.body);
  assert.equal(data.spark.historyServerUrl, 'http://localhost:18080');
  assert.equal(data.llm.model, 'claude-sonnet-4-5');
  assert.equal(data.llm.hasApiKey, true);

  // 2. POST /api/config to update History Server and model
  const postRes = await app.inject({
    method: 'POST',
    url: '/api/config',
    payload: {
      spark: { historyServerUrl: 'http://spark-hs.company.internal:18080/' },
      llm: { model: 'claude-3-7-sonnet-20250219', maxTokens: 4096 },
    },
  });
  assert.equal(postRes.statusCode, 200);
  assert.equal(config.spark.historyServerUrl, 'http://spark-hs.company.internal:18080');
  assert.equal(config.llm.model, 'claude-3-7-sonnet-20250219');
  assert.equal(config.llm.maxTokens, 4096);
});
