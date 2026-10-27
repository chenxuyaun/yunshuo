import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// domain 的 barrel 会带进 text.ts 的 node:crypto，Vite 在浏览器里直接抛错整页白屏。
// 浏览器代码只能从 ./plan 这类纯子路径取运行时值；类型导入会被擦除，不受限。
const VALUE_IMPORT_FROM_BARREL = /import\s+(?!type\b)[^;]*?from\s+'@yunshuo\/domain'/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

describe('浏览器入口', () => {
  it('不从 @yunshuo/domain barrel 取运行时值', () => {
    const offenders = sourceFiles(join(import.meta.dirname))
      .flatMap((file) => {
        const hits = readFileSync(file, 'utf8').match(VALUE_IMPORT_FROM_BARREL) ?? [];
        return hits.map((hit) => `${file}: ${hit.replace(/\s+/g, ' ')}`);
      })
      .sort();

    expect(offenders).toEqual([]);
  });
});
