import cors from '@fastify/cors';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getCodexHome, getStatePath } from './file-ops.js';
import { deleteAgentSession, fetchAgentJson, fetchAgentSessions, getRemoteAgents, wsUrlForAgent } from './remote-agents.js';
import { SessionService } from './session-service.js';
import { CuratorStore } from './store.js';
import { startCodexTerminal, type TerminalInput } from './terminal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = Fastify({ logger: true });
const codexHome = getCodexHome();
const store = new CuratorStore(getStatePath(codexHome));
const service = new SessionService(store);
const remoteAgents = getRemoteAgents();

const sessionCacheTtlMs = Number(process.env.CURATOR_SESSION_CACHE_TTL_MS || 8000);
const remoteSessionCacheTtlMs = Number(process.env.CURATOR_REMOTE_SESSION_CACHE_TTL_MS || 15000);
let localSessionsCache: { expiresAt: number; promise: Promise<Awaited<ReturnType<SessionService['listSessions']>>> } | null = null;
let remoteSessionsCache: { expiresAt: number; promise: Promise<Awaited<ReturnType<typeof fetchAgentSessions>>[]> } | null = null;

const keepSchema = z.object({ kept: z.boolean() });
const titleSchema = z.object({ title: z.string().max(120) });
const migrateSchema = z.object({ targetProjectDir: z.string().min(1).max(1000) });
const confirmSchema = z.object({ confirm: z.literal(true) });
const bulkDeleteSchema = z.object({ confirm: z.literal(true), ids: z.array(z.string().min(1).max(160)).min(1).max(200) });
const sessionIdSchema = z.object({ id: z.string().min(1).max(160) });

async function deleteSessionById(id: string) {
  try {
    return await service.deleteSession(id);
  } catch (localError) {
    for (const agent of remoteAgents) {
      try {
        return await deleteAgentSession(agent, id);
      } catch {
        // Try the next remote agent.
      }
    }
    throw localError;
  }
}

function clearSessionCaches(): void {
  localSessionsCache = null;
  remoteSessionsCache = null;
}

async function getLocalSessionsCached(refreshWorkflow: boolean) {
  if (refreshWorkflow || sessionCacheTtlMs <= 0) {
    clearSessionCaches();
    return service.listSessions({ refreshWorkflow });
  }
  const now = Date.now();
  if (!localSessionsCache || localSessionsCache.expiresAt <= now) {
    localSessionsCache = {
      expiresAt: now + sessionCacheTtlMs,
      promise: service.listSessions({ refreshWorkflow: false }),
    };
  }
  return localSessionsCache.promise;
}

async function getRemoteSessionsCached() {
  if (!remoteAgents.length) return [];
  if (remoteSessionCacheTtlMs <= 0) return (await Promise.all(remoteAgents.map((agent) => fetchAgentSessions(agent)))).flat();
  const now = Date.now();
  if (!remoteSessionsCache || remoteSessionsCache.expiresAt <= now) {
    remoteSessionsCache = {
      expiresAt: now + remoteSessionCacheTtlMs,
      promise: Promise.all(remoteAgents.map((agent) => fetchAgentSessions(agent))),
    };
  }
  return (await remoteSessionsCache.promise).flat();
}

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
await app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] });
await app.register(websocket);

app.addHook('onSend', async (request, reply, payload) => {
  if (request.url.startsWith('/assets/')) {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  }
  if (request.url === '/' || request.url.startsWith('/?')) {
    reply.header('Cache-Control', 'no-cache');
  }
  return payload;
});

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
      remote: z.enum(['0', '1', 'true', 'false']).optional(),
    })
    .parse(request.query);
  const refreshWorkflow = query.refresh === '1' || query.refresh === 'true';
  const includeRemote = query.remote !== '0' && query.remote !== 'false';
  const localSessions = await getLocalSessionsCached(refreshWorkflow);
  const remoteSessions = refreshWorkflow || !includeRemote
    ? []
    : await getRemoteSessionsCached();
  const sessions = [...localSessions, ...remoteSessions];
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
    meta: { ...service.getMeta(), remoteAgents: remoteAgents.map((agent) => ({ id: agent.id, baseUrl: agent.baseUrl })) },
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
    for (const agent of remoteAgents) {
      try {
        const path = `/api/sessions/${encodeURIComponent(params.id)}/history?limit=${query.limit ?? 80}${
          query.before === undefined ? '' : `&before=${query.before}`
        }`;
        return await fetchAgentJson(agent, path);
      } catch {
        // Try the next agent.
      }
    }
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'History failed' });
  }
});

app.get('/api/sessions/:id/terminal', { websocket: true }, async (socket, request) => {
  const params = sessionIdSchema.parse(request.params);
  const session = await service.getSession(params.id);
  if (!session) {
    for (const candidate of remoteAgents) {
      try {
        const RemoteWebSocket = globalThis.WebSocket as unknown as new (url: string) => {
          send(data: string): void;
          close(): void;
          addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
        };
        const remoteSocket = new RemoteWebSocket(wsUrlForAgent(candidate, `/api/sessions/${encodeURIComponent(params.id)}/terminal`));
        remoteSocket.addEventListener('message', (event) => {
          if (socket.readyState === 1) socket.send(String(event.data ?? ''));
        });
        remoteSocket.addEventListener('open', () => {
          socket.on('message', (raw: { toString(): string }) => remoteSocket.send(raw.toString()));
          socket.on('close', () => remoteSocket.close());
          socket.on('error', () => remoteSocket.close());
        });
        remoteSocket.addEventListener('error', () => {
          if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', data: `Remote terminal failed: ${candidate.id}` }));
        });
        remoteSocket.addEventListener('close', () => socket.close());
        return;
      } catch {
        // Try next remote agent.
      }
    }
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
  clearSessionCaches();
  return session;
});

app.post('/api/sessions/:id/title', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = titleSchema.parse(request.body);
  const session = await service.setTitle(params.id, body.title);
  if (!session) return reply.code(404).send({ error: 'Session not found' });
  clearSessionCaches();
  return session;
});

app.post('/api/sessions/:id/migrate', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  const body = migrateSchema.parse(request.body);
  try {
    const result = await service.migrateSessionToProject(params.id, body.targetProjectDir);
    clearSessionCaches();
    return result;
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Migrate failed' });
  }
});

app.delete('/api/sessions/:id', async (request, reply) => {
  const params = sessionIdSchema.parse(request.params);
  confirmSchema.parse(request.body);
  try {
    const result = await deleteSessionById(params.id);
    clearSessionCaches();
    return result;
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : 'Delete failed' });
  }
});

app.post('/api/sessions/prune', async (request) => {
  confirmSchema.parse(request.body);
  const result = await service.pruneRecommended('delete');
  clearSessionCaches();
  return result;
});

app.post('/api/sessions/prune-non-kept', async (request) => {
  confirmSchema.parse(request.body);
  const result = await service.pruneNonKept();
  clearSessionCaches();
  return result;
});

app.post('/api/sessions/bulk-delete', async (request) => {
  const body = bulkDeleteSchema.parse(request.body);
  const results = [];
  for (const id of body.ids) {
    try {
      const result = await deleteSessionById(id);
      results.push({ id, ok: true, result });
    } catch (error) {
      results.push({ id, ok: false, error: error instanceof Error ? error.message : 'Delete failed' });
    }
  }
  clearSessionCaches();
  return {
    deleted: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
});

const distPath = join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
  await app.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    setHeaders(response, pathName) {
      if (pathName.includes('/assets/')) {
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        response.setHeader('Cache-Control', 'no-cache');
      }
    },
  });
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
