import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configuration } from './config.js';
import { createServer } from './server.js';
import { createApp } from './http.js';
try {
  const config = configuration();
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
} catch {
  console.error('Startup failed. Check environment configuration (see .env.example).');
  process.exitCode = 1;
}
