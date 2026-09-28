import { z } from 'zod';
import { resolve } from 'node:path';
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
      INTERVALS_API_KEY: z.string().min(1).optional(),
      INTERVALS_ATHLETE_ID: z
        .string()
        .regex(/^(0|i?\d+)$/)
        .default('0'),
    })
    .parse(env);
  if (values.TRANSPORT === 'http' && !values.MCP_TOKEN)
    throw new Error('HTTP requires MCP_TOKEN (at least 32 characters).');
  if (values.PUBLIC_URL && new URL(values.PUBLIC_URL).protocol !== 'https:')
    throw new Error('PUBLIC_URL must use HTTPS.');
  return { ...values, COACH_DATA_DIR: resolve(values.COACH_DATA_DIR) };
}
export type Config = ReturnType<typeof configuration>;
