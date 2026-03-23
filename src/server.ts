/**
 * Entry point — builds the app and starts listening.
 */
import { buildApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { logger } from './lib/logger';

async function main() {
  const app = await buildApp();

  // Verify DB connection before accepting traffic
  await prisma.$connect();
  logger.info('PostgreSQL connected');

  await redis.connect();
  logger.info('Redis connected');

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info(`SwipeSmart API listening on ${env.HOST}:${env.PORT}`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  try {
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  } catch (err) {
    logger.error(err, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error(err, 'Failed to start server');
  process.exit(1);
});
