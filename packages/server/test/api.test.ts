import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

test('Token authentication guards protected API routes', async () => {
  const token = 'secret-test-token';
  const app = Fastify();

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return;
    if (req.url === '/api/health') return;

    const authHeader = req.headers.authorization;
    const tokenHeader = req.headers['x-sparksleuth-token'];
    let provided = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      provided = authHeader.slice(7).trim();
    } else if (typeof tokenHeader === 'string') {
      provided = tokenHeader.trim();
    }

    if (provided !== token) {
      return reply.code(401).send({ error: 'unauthorized: valid token required' });
    }
  });

  app.get('/api/health', async () => ({ ok: true, authRequired: true }));
  app.get('/api/sessions', async () => ({ sessions: [] }));

  // 1. Health check is public
  const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(healthRes.statusCode, 200);

  // 2. Protected route without token returns 401
  const unauthRes = await app.inject({ method: 'GET', url: '/api/sessions' });
  assert.equal(unauthRes.statusCode, 401);

  // 3. Protected route with invalid token returns 401
  const invalidRes = await app.inject({
    method: 'GET',
    url: '/api/sessions',
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(invalidRes.statusCode, 401);

  // 4. Protected route with valid Bearer token returns 200
  const validRes = await app.inject({
    method: 'GET',
    url: '/api/sessions',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(validRes.statusCode, 200);

  // 5. Protected route with x-sparksleuth-token header returns 200
  const headerRes = await app.inject({
    method: 'GET',
    url: '/api/sessions',
    headers: { 'x-sparksleuth-token': token },
  });
  assert.equal(headerRes.statusCode, 200);
});
