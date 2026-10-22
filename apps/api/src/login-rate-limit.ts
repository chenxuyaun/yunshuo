import { AppError } from './errors.js';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_ENTRIES = 10_000;

interface Entry {
  count: number;
  resetAt: number;
}

const failures = new Map<string, Entry>();

function prune(now: number): void {
  if (failures.size < MAX_ENTRIES) return;
  for (const [key, entry] of failures) {
    if (entry.resetAt <= now) failures.delete(key);
  }
}

export function loginRateLimitKey(email: string, ip: string): string {
  return `${email.toLowerCase()}|${ip}`;
}

export function assertRateLimit(
  key: string,
  max: number,
  windowMs: number,
  code: string,
  message: string,
): void {
  const now = Date.now();
  prune(now);
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) return;
  if (entry.count >= max) {
    throw new AppError(429, code, message);
  }
}

export function recordRateLimitHit(key: string, windowMs: number): void {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) {
    if (failures.size >= MAX_ENTRIES) {
      prune(now);
      while (failures.size >= MAX_ENTRIES) {
        const oldest = failures.keys().next();
        if (oldest.done) break;
        failures.delete(oldest.value);
      }
    }
    failures.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
}

export function clearRateLimit(key: string): void {
  failures.delete(key);
}

export function assertLoginAllowed(key: string, message?: string): void {
  assertRateLimit(
    key,
    MAX_FAILURES,
    WINDOW_MS,
    'LOGIN_RATE_LIMITED',
    message ?? '登录失败次数过多，请稍后再试',
  );
}

export function recordLoginFailure(key: string): void {
  recordRateLimitHit(key, WINDOW_MS);
}

export function clearLoginFailures(key: string): void {
  clearRateLimit(key);
}
