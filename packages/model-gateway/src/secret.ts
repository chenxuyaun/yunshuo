import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const HKDF_INFO = 'yunshuo:model-provider-key:v1';
const IV_BYTES = 12;

function deriveKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(HKDF_INFO, 'utf8'), 32),
  );
}

export function apiKeyHint(plaintext: string): string {
  if (plaintext.length <= 4) return '••••';
  return `••••${plaintext.slice(-4)}`;
}

export function encryptApiKey(
  plaintext: string,
  secret: string,
): { ciphertext: string; hint: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.'),
    hint: apiKeyHint(plaintext),
  };
}

export function decryptApiKey(ciphertext: string, secret: string): string {
  const [version, ivPart, tagPart, dataPart] = ciphertext.split('.');
  if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error('服务商密钥格式不受支持');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(secret),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
