import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(process.cwd(), '../../../.env'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      config({ path, override: false });
    }
  }
}

export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}；请从 .env.example 复制 .env`);
  }
  return value;
}
