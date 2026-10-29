/**
 * 模型端点的出网守卫：服务端会按这个地址主动出网，所以在发请求前先把目标钉死。
 *
 * 默认姿态（SSRF 防护）：只允许 http/https、不内嵌凭据，且 host 不得是本机、内网或保留地址。
 * 本机或内网自建推理端点（Ollama、LM Studio、局域网 vLLM）是受支持的用法，但必须由部署方
 * 显式设置 MODEL_ENDPOINT_ALLOW_PRIVATE=1 放行（见 env.ts）；云元数据与链路本地地址
 * （169.254.0.0/16、fe80::/10）即使放行开关打开也一律拒绝。
 *
 * 判定只针对 URL 解析器规范化后的字面量 host（`127.1`、`0x7f.1`、`[0:0:0:0:0:0:0:1]` 都会
 * 先被规范化），不做 DNS 解析：解析结果随时间变化（TOCTOU），拿它当守卫只会给出虚假的
 * 安全感；域名形式的内部地址不在本守卫覆盖范围内。
 */
import { badRequest } from '../errors.js';

export interface ModelEndpointGuardOptions {
  /** 部署方显式放行本机/内网端点（MODEL_ENDPOINT_ALLOW_PRIVATE=1）。默认拒绝。 */
  allowPrivateEndpoints?: boolean;
}

export type ModelEndpointHostClass = 'public' | 'private_or_reserved' | 'link_local';

/** 去掉 IPv6 方括号与主机名尾点，统一小写（IPv4 的各种写法已由 URL 解析器规范化）。 */
function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: [number, number, number, number] = [0, 0, 0, 0];
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index] ?? '';
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets[index] = value;
  }
  return octets;
}

function ipv4ToInt(octets: readonly number[]): number {
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  );
}

function ipv4InCidr(octets: readonly number[], base: readonly number[], prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(octets) & mask) === (ipv4ToInt(base) & mask);
}

/** 硬拒段：云元数据与链路本地地址，放行开关打开也不允许。 */
const LINK_LOCAL_V4_RANGES: ReadonlyArray<readonly [readonly number[], number]> = [
  [[169, 254, 0, 0], 16],
];

/** 默认拒绝段：环回、私网、运营商级 NAT（含 Tailscale 等）与各类保留地址。 */
const PRIVATE_OR_RESERVED_V4_RANGES: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0, 0, 0, 0], 8], // 本网络
  [[10, 0, 0, 0], 8], // 私网
  [[100, 64, 0, 0], 10], // 运营商级 NAT
  [[127, 0, 0, 0], 8], // 环回
  [[172, 16, 0, 0], 12], // 私网
  [[192, 0, 0, 0], 24], // IETF 协议保留
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 168, 0, 0], 16], // 私网
  [[198, 18, 0, 0], 15], // 基准测试保留
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // 组播
  [[240, 0, 0, 0], 4], // 保留
];

/** 解析 IPv6 字面量为 8 个 16 位组；不是合法 IPv6 字面量返回 null。 */
function parseIpv6(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const separator = host.indexOf('::');
  if (separator !== -1 && host.indexOf('::', separator + 2) !== -1) return null;
  const head = separator === -1 ? host : host.slice(0, separator);
  const tail = separator === -1 ? null : host.slice(separator + 2);
  const parseGroup = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return Number.parseInt(part, 16);
  };
  const headValues: number[] = [];
  for (const part of head === '' ? [] : head.split(':')) {
    const value = parseGroup(part);
    if (value === null) return null;
    headValues.push(value);
  }
  if (tail === null) return headValues.length === 8 ? headValues : null;
  const tailValues: number[] = [];
  for (const part of tail === '' ? [] : tail.split(':')) {
    const value = parseGroup(part);
    if (value === null) return null;
    tailValues.push(value);
  }
  const zeros = 8 - headValues.length - tailValues.length;
  if (zeros < 1) return null;
  return [...headValues, ...new Array<number>(zeros).fill(0), ...tailValues];
}

function classifyIpv4(octets: readonly number[]): ModelEndpointHostClass {
  if (LINK_LOCAL_V4_RANGES.some(([base, prefix]) => ipv4InCidr(octets, base, prefix))) {
    return 'link_local';
  }
  if (PRIVATE_OR_RESERVED_V4_RANGES.some(([base, prefix]) => ipv4InCidr(octets, base, prefix))) {
    return 'private_or_reserved';
  }
  return 'public';
}

function classifyIpv6(groups: readonly number[]): ModelEndpointHostClass {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    // IPv4-mapped：URL 解析器把 `::ffff:127.0.0.1` 规范化成 `::ffff:7f00:1`，按内嵌 IPv4 判定
    return classifyIpv4([(g >> 8) & 0xff, g & 0xff, (h >> 8) & 0xff, h & 0xff]);
  }
  if ((a & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10 链路本地
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h <= 1) {
    return 'private_or_reserved'; // :: 与 ::1
  }
  if ((a & 0xfe00) === 0xfc00) return 'private_or_reserved'; // fc00::/7 唯一本地地址
  if ((a & 0xff00) === 0xff00) return 'private_or_reserved'; // ff00::/8 组播
  return 'public';
}

/**
 * 按 URL 解析器规范化后的 host 分类。传入的应是 `URL.hostname`（可含 IPv6 方括号），
 * 不要传原始字符串——`127.1`、`0x7f.1` 这类写法只有解析器能规范化成点分十进制。
 */
export function classifyModelEndpointHost(hostname: string): ModelEndpointHostClass {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'private_or_reserved';
  const ipv4 = parseIpv4(host);
  if (ipv4) return classifyIpv4(ipv4);
  const ipv6 = parseIpv6(host);
  if (ipv6) return classifyIpv6(ipv6);
  return 'public';
}

/** 校验模型端点地址并返回结构化 URL；拼接请求路径交给 URL 解析器，不再手工拼字符串。 */
export function assertModelEndpointUrl(
  value: string,
  options: ModelEndpointGuardOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('VALIDATION', '模型端点不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('VALIDATION', '模型端点只支持 http/https');
  }
  if (url.username !== '' || url.password !== '') {
    throw badRequest('VALIDATION', '模型端点地址不能内嵌凭据');
  }
  const classification = classifyModelEndpointHost(url.hostname);
  if (classification === 'link_local') {
    throw badRequest(
      'VALIDATION',
      '模型端点不能指向云元数据或链路本地地址（169.254.0.0/16、fe80::/10）',
    );
  }
  if (classification === 'private_or_reserved' && !options.allowPrivateEndpoints) {
    throw badRequest(
      'VALIDATION',
      '模型端点不能指向本机、内网或保留地址；如需连接本机或内网自建推理端点（Ollama、LM Studio），请由部署方设置 MODEL_ENDPOINT_ALLOW_PRIVATE=1',
    );
  }
  return url;
}
