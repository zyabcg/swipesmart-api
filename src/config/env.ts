import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 characters'),
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY must be at least 16 characters'),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  ANTHROPIC_API_KEY: z.string().optional(),

  SESSION_TTL_DAYS: z.coerce.number().default(30),
  CARD_CACHE_TTL: z.coerce.number().default(3600),  // card catalog cache TTL in seconds
  CHAT_CACHE_TTL: z.coerce.number().default(3600),  // AI response cache TTL in seconds
});

function loadEnv() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:');
    result.error.issues.forEach((issue) => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
export type Env = typeof env;
