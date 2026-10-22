import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgres://yunshuo:yunshuo@localhost:5433/yunshuo_test',
    },
    setupFiles: ['./src/test-setup.ts'],
  },
});
