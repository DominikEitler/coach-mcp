import { ZodError } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configuration } from './config.js';
import { createServer } from './server.js';
import { createApp } from './http.js';
import { DataStore } from './data.js';
try {
  const config = configuration();
  if (config.GIT_AUTO_PUSH) {
    // Keep the checkout current with GitHub between writes, so edits made elsewhere
    // appear in reads and don't block the next write.
    const data = new DataStore(config.COACH_DATA_DIR, false, true);
    const sync = () =>
      data.sync().catch((e: unknown) => {
        console.error(`Data sync failed: ${e instanceof Error ? e.message : 'unknown error'}`);
      });
    void sync();
    setInterval(() => void sync(), 5 * 60 * 1000).unref();
  }
  if (config.TRANSPORT === 'stdio') {
    const server = createServer(config);
    await server.connect(new StdioServerTransport());
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => {
        void server.close().then(() => process.exit(0));
      });
  } else {
    const listener = createApp(config).listen(config.PORT, config.HOST, () =>
      console.error(`Coach MCP listening on ${config.HOST}:${config.PORT}`),
    );
    listener.on('error', () => {
      console.error('Unable to start HTTP listener. Check host and port.');
      process.exitCode = 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => {
        listener.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10000).unref();
      });
  }
} catch (e) {
  // Zod issues name the variable and rule, never the configured value of the secrets.
  const detail =
    e instanceof ZodError
      ? e.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : e instanceof Error
        ? e.message
        : 'unknown error';
  console.error(
    `Startup failed: ${detail.replace(/\.$/, '')}. Check environment configuration (see .env.example).`,
  );
  process.exitCode = 1;
}
