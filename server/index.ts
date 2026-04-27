import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getCodexHome, getStatePath } from './file-ops.js';
import { SessionService } from './session-service.js';
import { CuratorStore } from './store.js';
import { startCodexTerminal, type TerminalInput } from './terminal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = Fastify({ logger: true });
const codexHome = getCodexHome();
const store = new CuratorStore(getStatePath(codexHome));
const service = new SessionService(store);

const keepSchema = z.object({ kept: z.boolean() });
const titleSchema = z.object({ title: z.string().max(120) });
const migrateSchema = z.object({ targetProjectDir: z.string().min(1).max(1000) });
const confirmSchema = z.object({ confirm: z.literal(true) });
const sessionIdSchema = z.object({ id: z.string().min(1).max(160) });

await service.cleanupRecycleBin();
setInterval(
  () => {
    void service.cleanupRecycleBin().catch((error) => {
      app.log.warn({ error }, 'Recycle cleanup failed');
    });
  },
  6 * 60 * 60 * 1000
).unref();

await app.register(cors, { origin: true });
await app.register(websocket);

app.addHook('onRequest', async (request, reply) => {
  const authUser = process.env.CURATOR_AUTH_USER;
  const authPassword = process.env.CURATOR_AUTH_PASSWORD;
  const adminToken = process.env.CURATOR_ADMIN_TOKEN;
  if (!authUser || !authPassword || !adminToken) return;

  const url = new URL(request.url, 'http://127.0.0.1');
  const requestToken = url.searchParams.get('admin_token');
  if (requestToken === adminToken) {
    url.searchParams.delete('admin_token');
    const cleanPath = `${url.pathname}${url.search}${url.hash}`;
    const isHttps = request.headers['x-forwarded-proto'] === 'https' || request.headers['cf-visitor']?.includes('https');
    const secure = isHttps ? ' Secure;' : '';
    reply.header(
      'Set-Cookie',
      `curator_admin=${encodeURIComponent(adminToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000;${secure}`
    );
    if (request.method === 'GET') {
      await reply.redirect(cleanPath || '/');
      return;
    }
    return;
  }

  const cookies = Object.fromEntries(
    (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
  if (cookies.curator_admin === adminToken) return;

  const header = request.headers.authorization;
  const expected = `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString('base64')}`;
  if (header === expected) return;

  reply.header('WWW-Authenticate', 'Basic realm="Codex Session Curator"');
  await reply.code(401).send({ error: 'Authentication required' });
});

app.get('/api/meta', async () => service.getMeta());

app.get('/api/sessions', async (request) => {
  const query = z
    .object({
      q: z.string().optional(),
      recommendation: z.enum(['all', 'keep', 'review', 'delete']).optional(),
      refresh: z.enum(['0', '1', 'true', 'false']).optional(),
    })
    .parse(request.query);
  const sessions = await service.listSessions({ refreshWorkflow: query.refresh === '1' || query.refresh === 'true' });
  const filtered = sessions.filter((session) => {
    const matchesRecommendation =
      !query.recommendation ||
      query.recommendation === 'all' ||
      session.evaluation.recommendation === query.recommendation;
    const text = [
      session.id,
      session.title,
      session.resumeCommand,
      session.cwd ?? '',
      session.machineId,
      session.evaluation.summary,
      session.evaluation.detailedSummary,
      ...session.evaluation.actualWorkdirs,
      session.evaluation.recommendedWorkdir ?? '',
      ...session.evaluation.remoteMachines.map((machine) =>
        [machine.label, machine.host, machine.ip, machine.user].filter(Boolean).join(' ')
      ),
    ]
      .join(' ')
      .toLowerCase();
    const matchesQuery = !query.q || text.includes(query.q.toLowerCase());
    return matchesRecommendation && matchesQuery;
  });

  return {
    meta: service.getMeta(),
    sessions: filtered,
    total: sessions.length,
  };
});

app.get('/api/sessions/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const session = await service.getSession(params.id);
  if (!session) return reply.code(404).send({ error: 'Session not found' });
  return session;
});

app.get('/api/sessions/:id/history', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      before: z.coerce.number().int().min(0).optional(),
    })
    .parse(request.query);
  try {
    return await service.getSessionHistory(params.id, { limit: query.limit, beforeIndex: query.before ?? null });
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'History failed' });
  }
});

app.get('/api/sessions/:id/terminal', { websocket: true }, async (socket, request) => {
  const params = sessionIdSchema.parse(request.params);
  const session = await service.getSession(params.id);
  if (!session) {
    socket.send(JSON.stringify({ type: 'error', data: 'Session not found' }));
    socket.close();
    return;
  }

  const terminal = startCodexTerminal(session, (message) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  });

  socket.on('message', (raw: { toString(): string }) => {
    try {
      terminal.write(JSON.parse(raw.toString()) as TerminalInput);
    } catch {
      socket.send(JSON.stringify({ type: 'error', data: 'Invalid terminal input' }));
    }
  });
  socket.on('close', () => terminal.close());
  socket.on('error', () => terminal.close());
});

app.get('/api/recycle-bin', async () => ({
  meta: service.getMeta(),
  archives: await service.listRecycleBin(),
}));

app.post('/api/sessions/:id/keep', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = keepSchema.parse(request.body);
  const session = await service.setKept(params.id, body.kept);
  if (!session) return reply.code(404).send({ error: 'Session not found' });
  return session;
});

app.post('/api/sessions/:id/title', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = titleSchema.parse(request.body);
  const session = await service.setTitle(params.id, body.title);
  if (!session) return reply.code(404).send({ error: 'Session not found' });
  return session;
});

app.post('/api/sessions/:id/migrate', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = migrateSchema.parse(request.body);
  try {
    return await service.migrateSessionToProject(params.id, body.targetProjectDir);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Migrate failed' });
  }
});

app.delete('/api/sessions/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  confirmSchema.parse(request.body);
  try {
    return await service.deleteSession(params.id);
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Delete failed' });
  }
});

app.post('/api/sessions/prune', async (request) => {
  confirmSchema.parse(request.body);
  return service.pruneRecommended('delete');
});

app.post('/api/sessions/prune-non-kept', async (request) => {
  confirmSchema.parse(request.body);
  return service.pruneNonKept();
});

const distPath = join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
  await app.register(fastifyStatic, { root: distPath, prefix: '/' });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    reply.sendFile('index.html');
  });
}

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 54177);

await app.listen({ host, port });
app.log.info(`Codex Session Curator listening on http://${host}:${port}`);
