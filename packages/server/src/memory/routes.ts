import type { FastifyInstance } from 'fastify';
import type { LLMClient } from '@sparksleuth/core';
import { Db } from '../db.js';
import { MemoryStoreImpl } from './store.js';
import { runDream } from './dream.js';
import { languageBodySchema, type GenerationLanguage } from './localization.js';

export function registerMemoryRoutes(app: FastifyInstance, db: Db, memory: MemoryStoreImpl, client: () => LLMClient): void {
  // GETs return saved sources unchanged. Legacy language query parameters are ignored.
  app.get<{ Querystring: { keyword?: string; days?: string; limit?: string } }>('/api/memory', async (req) => {
    return memory.search({ keyword: req.query.keyword, days: req.query.days ? Number(req.query.days) : undefined, limit: Math.min(100, Math.max(1, Number(req.query.limit) || 20)) });
  });
  app.get<{ Params: { sid: string } }>('/api/memory/:sid', async (req, reply) => {
    const doc = await memory.get(req.params.sid);
    if (!doc) return reply.code(404).send({ error: 'not found' });
    return reply.type('text/markdown').send(doc);
  });
  app.get('/api/memory/experience', async () => {
    return { items: await memory.experience() };
  });
  app.post<{ Body: { language?: GenerationLanguage } }>('/api/memory/dream', {
    schema: { body: languageBodySchema },
    preValidation: async (req) => { if (req.body === undefined) req.body = {}; },
  }, async (req) => {
    if (req.body?.language) db.setPreference('dream.language', req.body.language);
    return runDream(db, memory, client(), { language: req.body?.language });
  });
  app.get<{ Querystring: { status?: string } }>('/api/memory/dream/candidates', async (req) => {
    return db.listDreamCandidates(req.query.status);
  });
  app.post<{ Params: { id: string }; Body: { action?: 'approve' | 'reject' } }>('/api/memory/dream/candidates/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const candidate = db.listDreamCandidates().find((c) => c.id === id);
    if (!candidate) return reply.code(404).send({ error: 'not found' });
    if (req.body?.action === 'approve') {
      // Approval promotes exactly the saved candidate, without translation or regeneration.
      const path = await memory.promoteLesson([candidate.content], 'lessons');
      db.reviewDreamCandidate(id, 'approved');
      return { ok: true, path };
    }
    db.reviewDreamCandidate(id, 'rejected');
    return { ok: true };
  });
}
