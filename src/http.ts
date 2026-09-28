import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { createServer } from './server.js';
export function createApp(config: Config) {
  if (!config.MCP_TOKEN) throw new Error('HTTP requires MCP_TOKEN.');
  const hash = (s: string) => createHash('sha256').update(s).digest();
  const expected = hash('Bearer ' + config.MCP_TOKEN);
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/mcp', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const hosts = ['localhost', '127.0.0.1', '[::1]'];
    if (config.PUBLIC_URL) hosts.push(new URL(config.PUBLIC_URL).hostname);
    if (!hosts.includes(req.hostname)) {
      res.status(403).json({ error: 'Invalid host' });
      return;
    }
    const origin = req.get('origin');
    if (origin && (!config.PUBLIC_URL || origin !== new URL(config.PUBLIC_URL).origin)) {
      res.status(403).json({ error: 'Invalid origin' });
      return;
    }
    if (!timingSafeEqual(hash(req.get('authorization') ?? ''), expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="coach-mcp"');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });
  app.post('/mcp', express.json({ limit: '256kb' }), async (req, res) => {
    const server = createServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  });
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Use POST with the stateless MCP transport' });
  });
  const errors: express.ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ error: 'Invalid request body' });
  };
  app.use(errors);
  return app;
}
