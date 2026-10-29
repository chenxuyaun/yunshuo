import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgres://yunshuo:yunshuo@localhost:5433/yunshuo_test',
      // 测试用桩服务都在 127.0.0.1 上起：给测试进程显式放行本机端点。
      // 默认拒绝的姿态由 model-endpoint-guard.test.ts 在独立进程模块里验证。
      MODEL_ENDPOINT_ALLOW_PRIVATE: '1',
    },
    setupFiles: ['./src/test-setup.ts'],
  },
});
