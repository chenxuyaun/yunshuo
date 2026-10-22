import { describe, expect, it } from 'vitest';
import { apiKeyHint, decryptApiKey, encryptApiKey } from './secret.js';

const SECRET = 'test-provider-secret';

describe('provider secret', () => {
  it('roundtrips an API key without storing plaintext', () => {
    const plaintext = 'sk-test-1234567890';
    const encrypted = encryptApiKey(plaintext, SECRET);

    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(encrypted.ciphertext.startsWith('v1.')).toBe(true);
    expect(decryptApiKey(encrypted.ciphertext, SECRET)).toBe(plaintext);
    expect(encrypted.hint).toBe('••••7890');
  });

  it('uses a fresh IV for every encryption', () => {
    const first = encryptApiKey('same-key', SECRET);
    const second = encryptApiKey('same-key', SECRET);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptApiKey('sk-test-abcdef', SECRET);
    const parts = encrypted.ciphertext.split('.');
    const data = parts[3]!;
    parts[3] = `${data.slice(0, -2)}xx`;
    expect(() => decryptApiKey(parts.join('.'), SECRET)).toThrow();
  });

  it('rejects a different secret', () => {
    const encrypted = encryptApiKey('sk-test-abcdef', SECRET);
    expect(() => decryptApiKey(encrypted.ciphertext, 'another-secret')).toThrow();
  });

  it('hides short keys completely', () => {
    expect(apiKeyHint('abc')).toBe('••••');
  });
});
