import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `/api/health` 是 Studio 部署的健康判定：`docker-compose.studio.yml:107` 用
 * `fetch('http://127.0.0.1:3000/api/health').then(r => { if (!r.ok) process.exit(1) })`
 * 决定容器是否健康，`retries: 12 / timeout: 5s`。此前这条端点一条断言都没有。
 *
 * 这一族不写库：第一条用真库跑通 200，第二条把连接池关掉制造真的"数据库不可达"，
 * 验的是它不会谎报 ok。用例顺序是有前提的（第二条会关掉池），别把两条调换或并行。
 */
const SHAPE_KEYS = ['database', 'service', 'status', 'time'];

// 命名类型只为了让 body.time 是 string；Object.keys 那一条读的仍是运行时真实键集，
// 所以声明成四键并不会把"多一个键/少一个键"这两种走样遮掉（对照枪 H4/H5/H8）。
type HealthBody = { database: string; service: string; status: string; time: string };

describe('/api/health 的两种回答', () => {
  let app: FastifyInstance;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeAll(async () => {
    // 503 那条会走 request.log.error；不静音的话 vitest 输出里会混进一段真堆栈。
    process.env.LOG_LEVEL = 'silent';
    const { buildServer } = await import('./server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  it('库通着时四键齐全、status=ok，time 是可解析的 ISO 串', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as HealthBody;
    expect(Object.keys(body).sort()).toEqual(SHAPE_KEYS);
    expect(body.status).toBe('ok');
    expect(body.database).toBe('ok');
    expect(body.service).toBe('yunshuo-api');
    const stamp = Date.parse(body.time);
    expect(Number.isNaN(stamp)).toBe(false);
    expect(Math.abs(Date.now() - stamp)).toBeLessThan(60_000);
  });

  it('库不可达时报 503 并逐项降级，绝不谎报 ok', async () => {
    const { closeDb } = await import('@yunshuo/db');
    await closeDb();

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const body = response.json() as HealthBody;
    expect(response.statusCode).toBe(503);
    expect(Object.keys(body).sort()).toEqual(SHAPE_KEYS);
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('unreachable');
    expect(body.service).toBe('yunshuo-api');
    // 降级侧的 time 也得是"当下"：这一支单独钉一次，因为它是两个分支里唯一没被第一条
    // 走过的 return。否则把这里写成固定的 '2020-…' 也能全绿（对照枪 H9 实测过这个空放）。
    const stamp = Date.parse(body.time);
    expect(Number.isNaN(stamp)).toBe(false);
    expect(Math.abs(Date.now() - stamp)).toBeLessThan(60_000);
    // 部署那边只看 r.ok，所以状态码这一条才是容器判定的支点；文案降级只是给人看的第二层。
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(body.status).not.toBe('ok');
  });
});
