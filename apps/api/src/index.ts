import { closeDb, sql } from '@yunshuo/db';
import { env } from './env.js';
import { buildServer } from './server.js';
import { startAutomationRunner, stopAutomationRunner } from './services/automation-runner.js';

await sql`SELECT 1`;

const app = await buildServer();
if (env.automationRunner) {
  startAutomationRunner(env.automationPollMs);
  app.log.info({ pollMs: env.automationPollMs }, 'automation runner started');
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await stopAutomationRunner();
  await app.close();
  await closeDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: env.port, host: env.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
