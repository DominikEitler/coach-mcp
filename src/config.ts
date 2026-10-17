import { z } from 'zod';
import { resolve } from 'node:path';
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
export function configuration(env = process.env) {
  const values = z
    .object({
      TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      MCP_TOKEN: z.string().min(32).optional(),
      PUBLIC_URL: z.string().url().optional(),
      COACH_DATA_DIR: z.string().default('../coach-data'),
      ENABLE_DATA_WRITES: flag,
      GIT_AUTO_PUSH: flag,
      ENABLE_INTERVALS_WRITES: flag,
      ENABLE_NOTIFICATIONS: flag,
      NTFY_URL: z.string().url().optional(),
      NTFY_TOPIC: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .default('coach'),
      NTFY_TOKEN: z.string().min(1).optional(),
      NOTIFY_MORNING: time.default('07:00'),
      NOTIFY_EVENING: time.default('21:00'),
      NOTIFY_WEEKLY: time.default('18:00'),
      ATHLETE_TIMEZONE: z
        .string()
        .default('Europe/Vienna')
        .refine((zone) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: zone });
            return true;
          } catch {
            return false;
          }
        }, 'Use an IANA time zone such as Europe/Vienna'),
      INTERVALS_API_KEY: z.string().min(1).optional(),
      INTERVALS_ATHLETE_ID: z
        .string()
        .regex(/^(0|i?\d+)$/)
        .default('0'),
    })
    .parse(env);
  if (values.TRANSPORT === 'http' && !values.MCP_TOKEN)
    throw new Error('HTTP requires MCP_TOKEN (at least 32 characters).');
  if (values.ENABLE_NOTIFICATIONS && !(values.NTFY_URL && values.NTFY_TOKEN))
    throw new Error('Notifications require NTFY_URL and NTFY_TOKEN.');
  if (values.PUBLIC_URL && new URL(values.PUBLIC_URL).protocol !== 'https:')
    throw new Error('PUBLIC_URL must use HTTPS.');
  return { ...values, COACH_DATA_DIR: resolve(values.COACH_DATA_DIR) };
}
export type Config = ReturnType<typeof configuration>;
