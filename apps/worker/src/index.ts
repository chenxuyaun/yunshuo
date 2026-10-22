import { closeDb, loadEnv } from '@yunshuo/db';
import { recoverStaleOutbox, runOutboxTick } from './pipeline.js';

loadEnv();

if (process.env.NODE_ENV === 'production' && !process.env.MODEL_KEY_SECRET?.trim()) {
  console.error('[worker] 生产环境必须设置 MODEL_KEY_SECRET，且与 API 的加密主密钥一致');
  process.exit(1);
}

const POLL_MS = 1000;

let running = true;

async function shutdown(): Promise<void> {
  running = false;
  await closeDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

const recovered = await recoverStaleOutbox();

console.log('[worker] started; polling outbox every 1000ms');
console.log(
  `[worker] 回收 ${recovered} 条超时未完成的索引任务；嵌入服务商在界面按用途 embedding 配置`,
);

while (running) {
  try {
    await runOutboxTick();
  } catch (error) {
    console.error('[worker] tick failed:', error);
  }
  if (running) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
