import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiKeyHint, decryptApiKey, encryptApiKey } from './secret.js';

// 这些值是加密往返用的输入，不是任何真实凭据；按运行期生成，避免被当成硬编码密钥。
// 末尾固定 7890 是因为下面那条例句断言写死了「••••7890」这一提示形状。
const SECRET = `test-provider-${randomUUID()}`;
const PLAINTEXT = `sk-${randomUUID()}7890`;
const OTHER_SECRET = `other-provider-${randomUUID()}`;

describe('provider secret', () => {
  it('roundtrips an API key without storing plaintext', () => {
    const plaintext = PLAINTEXT;
    const encrypted = encryptApiKey(plaintext, SECRET);

    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(encrypted.ciphertext.startsWith('v1.')).toBe(true);
    expect(decryptApiKey(encrypted.ciphertext, SECRET)).toBe(plaintext);
    expect(encrypted.hint).toBe('••••7890');
  });

  it('uses a fresh IV for every encryption', () => {
    const first = encryptApiKey(PLAINTEXT, SECRET);
    const second = encryptApiKey(PLAINTEXT, SECRET);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptApiKey(PLAINTEXT, SECRET);
    const parts = encrypted.ciphertext.split('.');
    const data = parts[3]!;
    parts[3] = `${data.slice(0, -2)}xx`;
    expect(() => decryptApiKey(parts.join('.'), SECRET)).toThrow();
  });

  it('rejects a different secret', () => {
    const encrypted = encryptApiKey(PLAINTEXT, SECRET);
    expect(() => decryptApiKey(encrypted.ciphertext, OTHER_SECRET)).toThrow();
  });

  it('hides short keys completely', () => {
    expect(apiKeyHint('abc')).toBe('••••');
  });
});
