import { ZodError } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configuration } from './config.js';
import { createServer } from './server.js';
import { createApp } from './http.js';
import { DataStore } from './data.js';
import { Intervals } from './intervals.js';
import { Coaching } from './coaching.js';
import { Notifier, startSchedule } from './notify.js';
try {
  const config = configuration();
  const notifier =
    config.ENABLE_NOTIFICATIONS && config.NTFY_URL && config.NTFY_TOKEN
      ? new Notifier(config.NTFY_URL, config.NTFY_TOPIC, config.NTFY_TOKEN)
      : undefined;
  if (notifier) {
    const api = new Intervals(config.INTERVALS_API_KEY, config.INTERVALS_ATHLETE_ID);
    const data = new DataStore(config.COACH_DATA_DIR);
    startSchedule(
      new Coaching(api, data, config.ATHLETE_TIMEZONE),
      notifier,
      config.ATHLETE_TIMEZONE,
      {
        morning: config.NOTIFY_MORNING,
        evening: config.NOTIFY_EVENING,
        weekly: config.NOTIFY_WEEKLY,
      },
    );
  }
  if (config.GIT_AUTO_PUSH) {
    // Keep the checkout current with GitHub between writes, so edits made elsewhere
    // appear in reads and don't block the next write. Report a failure once, and again
    // when it is resolved.
    const data = new DataStore(config.COACH_DATA_DIR, false, true);
    let failing = false;
    const alert = (title: string, body: string, high = false) =>
      notifier
        ?.send(
          {
            title,
            body,
            question: 'The coach data sync reported a problem. What should I check?',
            tags: high ? 'rotating_light' : 'white_check_mark',
          },
          high ? 'high' : undefined,
        )
        .catch(() => console.error('Sync alert could not be sent.'));
    const sync = () =>
      data.sync().then(
        () => {
          if (failing)
            void alert('Data sync recovered', 'GitHub and the server checkout are in line again.');
          failing = false;
        },
        (e: unknown) => {
          const message = e instanceof Error ? e.message : 'unknown error';
          console.error(`Data sync failed: ${message}`);
          if (!failing) void alert('Data sync failed', message, true);
          failing = true;
        },
      );
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
