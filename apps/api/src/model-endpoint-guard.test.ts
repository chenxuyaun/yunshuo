import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from './auth.js';
import {
  assertModelEndpointUrl,
  classifyModelEndpointHost,
} from './services/model-endpoint-guard.js';

/**
 * 这一族测的是模型端点的出网守卫（SSRF 防护）：
 * 第一组是纯分类表（不碰环境变量、不碰数据库）；第二组验服务层接线——
 * 闸都在触库之前抛出，所以不需要测试库里的任何数据。
 *
 * 放行开关默认关闭，但本文件整体跑在 `vitest.config.ts` 的
 * `MODEL_ENDPOINT_ALLOW_PRIVATE=1` 下（其他套件的桩服务都在 127.0.0.1）。
 * 这里用 `vi.resetModules()` + 动态导入重取模块，把开关按用例拨到需要的值；
 * `packages/db/src/env.ts:17` 用 `override: false` 读根目录 `.env`，要模拟关闭
 * 必须显式写成空串（键存在但值不算数），不能只 delete。
 */

interface ErrorShape {
  statusCode: number;
  code: string;
  message: string;
}

function expectRejected(
  value: string,
  options?: { allowPrivateEndpoints?: boolean },
): ErrorShape {
  let caught: unknown = null;
  try {
    assertModelEndpointUrl(value, options);
  } catch (error) {
    caught = error;
  }
  expect(caught, `${value} 应被拒绝`).toBeTruthy();
  const shape = caught as Partial<ErrorShape>;
  expect(shape.statusCode).toBe(400);
  expect(shape.code).toBe('VALIDATION');
  return { statusCode: 400, code: 'VALIDATION', message: shape.message ?? '' };
}

function expectAccepted(value: string, options?: { allowPrivateEndpoints?: boolean }): URL {
  return assertModelEndpointUrl(value, options);
}

const ownerAuth: AuthContext = {
  user: {
    id: '00000000-0000-4000-8000-00000000a001',
    email: 'guard-owner@example.test',
    name: '守卫用例所有者',
  },
  workspace: {
    id: '00000000-0000-4000-8000-00000000a002',
    name: '守卫用例工作区',
    settingsVersion: 1,
    ledgerVersion: 1,
  },
  role: 'owner',
  sessionId: 'model-endpoint-guard-test',
};

const originalFlag = process.env.MODEL_ENDPOINT_ALLOW_PRIVATE;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.MODEL_ENDPOINT_ALLOW_PRIVATE;
  else process.env.MODEL_ENDPOINT_ALLOW_PRIVATE = originalFlag;
  vi.resetModules();
});

/** 把放行开关拨到指定值后重新导入服务模块（env.ts 的导出对象在导入时定型）。 */
async function freshProviderService(
  flag: '' | '1',
): Promise<typeof import('./services/provider-service.js')> {
  process.env.MODEL_ENDPOINT_ALLOW_PRIVATE = flag;
  vi.resetModules();
  return await import('./services/provider-service.js');
}

async function expectServiceRejected(run: () => Promise<unknown>, fragment: string): Promise<void> {
  let caught: unknown = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeTruthy();
  const shape = caught as Partial<ErrorShape>;
  expect(shape.statusCode).toBe(400);
  expect(shape.code).toBe('VALIDATION');
  expect(shape.message).toContain(fragment);
}

describe('模型端点守卫：默认拒绝本机/内网/保留地址', () => {
  it('拒绝环回、私网与保留地址的各种写法（含 URL 解析器规范化后的形式）', () => {
    const blocked = [
      'http://127.0.0.1:11434/v1',
      'http://127.0.0.1/v1',
      'http://0177.0.0.1:11434/v1', // 八进制写法，规范化成 127.0.0.1
      'http://127.1:11434/v1', // 短写法，规范化成 127.0.0.1
      'http://0x7f.1:11434/v1', // 十六进制写法，规范化成 127.0.0.1
      'http://localhost:11434/v1',
      'http://localhost.:11434/v1', // 尾点
      'http://api.localhost/v1',
      'http://[::1]:11434/v1',
      'http://[0:0:0:0:0:0:0:1]/v1',
      'http://[::ffff:127.0.0.1]:11434/v1', // IPv4-mapped，规范化成 ::ffff:7f00:1
      'http://0.0.0.0:8080/v1',
      'http://10.0.0.8/v1',
      'http://172.16.5.4/v1',
      'http://192.168.1.10:8000/v1',
      'http://100.100.1.1/v1', // 运营商级 NAT（Tailscale 网段）
      'http://198.18.0.1/v1', // 基准测试保留
      'http://240.0.0.1/v1', // 保留段
      'http://[fd00::1]/v1', // 唯一本地地址
      'http://[ff02::1]/v1', // 组播
    ];
    for (const value of blocked) {
      const error = expectRejected(value);
      expect(error.message).toContain('MODEL_ENDPOINT_ALLOW_PRIVATE');
    }
  });

  it('公网地址放行，边界地址不被误伤', () => {
    const allowed = [
      'https://api.deepseek.com/v1',
      'https://api.openai.com/v1',
      'http://9.255.255.255/v1',
      'http://11.0.0.1/v1',
      'http://126.255.255.255/v1',
      'http://128.0.0.1/v1',
      'http://169.253.255.255/v1', // 169.254.0.0/16 的上边界外
      'http://169.255.0.1/v1',
      'http://172.15.255.255/v1', // 172.16.0.0/12 的下边界外
      'http://172.32.0.1/v1',
      'http://192.167.255.255/v1',
      'http://192.169.0.1/v1',
      'http://100.63.255.255/v1', // 100.64.0.0/10 的下边界外
      'http://100.128.0.1/v1',
      'http://223.255.255.255/v1',
      'http://[2606:4700:4700::1111]/v1',
    ];
    for (const value of allowed) {
      expect(expectAccepted(value).hostname.length, value).toBeGreaterThan(0);
    }
  });

  it('云元数据与链路本地地址即使用放行开关也硬拒', () => {
    const hardBlocked = [
      'http://169.254.169.254/latest/meta-data',
      'http://169.254.0.1/v1',
      'http://[fe80::1]/v1',
      'http://[::ffff:169.254.169.254]/v1', // 规范化成 ::ffff:a9fe:a9fe
    ];
    for (const value of hardBlocked) {
      const error = expectRejected(value, { allowPrivateEndpoints: true });
      expect(error.message).toContain('云元数据');
    }
  });

  it('放行开关只对本机/内网生效', () => {
    expect(expectAccepted('http://127.0.0.1:11434/v1', { allowPrivateEndpoints: true }).port).toBe(
      '11434',
    );
    expectAccepted('http://localhost:11434/v1', { allowPrivateEndpoints: true });
    expectAccepted('http://[::1]:11434/v1', { allowPrivateEndpoints: true });
    expectAccepted('http://10.1.2.3:8000/v1', { allowPrivateEndpoints: true });
    expectAccepted('http://192.168.1.10:8000/v1', { allowPrivateEndpoints: true });
  });

  it('协议、凭据与非法 URL', () => {
    expect(expectRejected('ftp://example.com/v1').message).toContain('http/https');
    expect(expectRejected('file:///etc/passwd').message).toContain('http/https');
    expect(expectRejected('http://user:secret@example.com/v1').message).toContain('凭据');
    expect(expectRejected('不是地址').message).toContain('合法 URL');
    expect(expectRejected('').message).toContain('合法 URL');
  });

  it('分类函数与拒绝口径一致', () => {
    expect(classifyModelEndpointHost('[::ffff:7f00:1]')).toBe('private_or_reserved');
    expect(classifyModelEndpointHost('[::1]')).toBe('private_or_reserved');
    expect(classifyModelEndpointHost('[fe80::1]')).toBe('link_local');
    expect(classifyModelEndpointHost('[::ffff:a9fe:a9fe]')).toBe('link_local');
    expect(classifyModelEndpointHost('localhost.')).toBe('private_or_reserved');
    expect(classifyModelEndpointHost('api.example.com')).toBe('public');
  });
});

describe('模型端点守卫：服务层接线', () => {
  it('开关关闭时，拉取模型清单/新增/修改/嵌入探测都在触库前拒绝本机地址', async () => {
    const service = await freshProviderService('');
    await expectServiceRejected(
      () => service.discoverModels(ownerAuth, { baseUrl: 'http://127.0.0.1:11434/v1' }),
      'MODEL_ENDPOINT_ALLOW_PRIVATE',
    );
    await expectServiceRejected(
      () =>
        service.createProvider(ownerAuth, {
          name: '本机端点',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'qwen2.5:3b',
          purpose: 'chat',
          isEnabled: true,
          priority: 10,
          priceCurrency: 'CNY',
        }),
      'MODEL_ENDPOINT_ALLOW_PRIVATE',
    );
    await expectServiceRejected(
      () =>
        service.updateProvider(ownerAuth, '00000000-0000-4000-8000-00000000a0ff', {
          baseUrl: 'http://10.0.0.5:8000/v1',
        }),
      'MODEL_ENDPOINT_ALLOW_PRIVATE',
    );
    await expectServiceRejected(
      () =>
        service.probeEmbedding(ownerAuth, {
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'bge-m3',
        }),
      'MODEL_ENDPOINT_ALLOW_PRIVATE',
    );
  });

  it('开关打开也拦得住云元数据地址', async () => {
    const service = await freshProviderService('1');
    await expectServiceRejected(
      () => service.discoverModels(ownerAuth, { baseUrl: 'http://169.254.169.254/v1' }),
      '云元数据',
    );
  });

  it('开关打开时，本机端点正常出网（对桩服务拉取模型清单）', async () => {
    const stubKey = `guard-stub-${randomUUID()}`;
    let seenPath = '';
    const stub: Server = createServer((request, response) => {
      seenPath = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'guard-stub-model' }] }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as AddressInfo).port;
    try {
      const service = await freshProviderService('1');
      const result = await service.discoverModels(ownerAuth, {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: stubKey,
      });
      expect(result.models).toEqual(['guard-stub-model']);
      expect(seenPath).toBe('/v1/models');
    } finally {
      await new Promise<void>((resolve, reject) =>
        stub.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
