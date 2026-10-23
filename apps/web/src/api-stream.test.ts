import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, streamAiProposal, type AiProposalPayload, type AiProposalStreamHandlers } from './api.js';

function sseResponse(
  chunks: string[],
  init: { status?: number; contentType?: string } = {},
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status: init.status ?? 200,
      headers: { 'content-type': init.contentType ?? 'text/event-stream' },
    },
  );
}

function recorder(): { events: Array<[string, unknown]>; handlers: AiProposalStreamHandlers } {
  const events: Array<[string, unknown]> = [];
  return {
    events,
    handlers: {
      onMeta: (meta) => events.push(['meta', meta]),
      onDelta: (text) => events.push(['delta', text]),
      onAttempt: (attempt) => events.push(['attempt', attempt]),
      onDone: (proposal) => events.push(['done', proposal]),
      onError: (error) => events.push(['error', error]),
    },
  };
}

const payload = { mode: 'continue', targetWords: 800 } as AiProposalPayload;
const signal = new AbortController().signal;

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe('streamAiProposal 的 SSE 解析', () => {
  it('跨读取块的帧、CRLF 与多种事件都能按顺序分发', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event: meta\r\ndata: {"proposalId":"p1"}\r\n\r\n',
        'event: del',
        'ta\r\ndata: {"text":"你',
        '好"}\r\n\r\n',
        'event: attempt\r\ndata: {"attempt":2}\r\n\r\n',
        'event: done\r\ndata: {"proposal":{"id":"p1"}}\r\n\r\n',
      ]),
    );
    const { events, handlers } = recorder();
    await streamAiProposal('chapter-1', payload, handlers, signal);
    expect(events).toEqual([
      ['meta', { proposalId: 'p1' }],
      ['delta', '你好'],
      ['attempt', { attempt: 2 }],
      ['done', { id: 'p1' }],
    ]);
  });

  it('done 是终止帧：同一缓冲区里它后面的事件不再分发', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event: delta\ndata: {"text":"A"}\n\n' +
          'event: done\ndata: {"proposal":{"id":"p2"}}\n\n' +
          'event: delta\ndata: {"text":"B"}\n\n',
      ]),
    );
    const { events, handlers } = recorder();
    await streamAiProposal('chapter-1', payload, handlers, signal);
    expect(events).toEqual([
      ['delta', 'A'],
      ['done', { id: 'p2' }],
    ]);
  });

  it('流尾没有空行隔开的最后一帧也会被处理', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event: delta\ndata: {"text":"尾"}\n\n' +
          'event: done\ndata: {"proposal":{"id":"p3"}}',
      ]),
    );
    const { events, handlers } = recorder();
    await streamAiProposal('chapter-1', payload, handlers, signal);
    expect(events).toEqual([
      ['delta', '尾'],
      ['done', { id: 'p3' }],
    ]);
  });

  it('空 delta 与坏 JSON 帧被跳过，不会污染正文', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event: delta\ndata: {"text":""}\n\n',
        'event: delta\ndata: not-json\n\n',
        'event: done\ndata: {"proposal":{"id":"p4"}}\n\n',
      ]),
    );
    const { events, handlers } = recorder();
    await streamAiProposal('chapter-1', payload, handlers, signal);
    expect(events).toEqual([['done', { id: 'p4' }]]);
  });

  it('流结束前没有终止帧：抛“提案未完成”', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['event: delta\ndata: {"text":"半"}\n\n']));
    const { events, handlers } = recorder();
    await expect(streamAiProposal('chapter-1', payload, handlers, signal)).rejects.toThrow(
      '生成连接中断，提案未完成',
    );
    expect(events).toEqual([['delta', '半']]);
  });

  it('HTTP 失败带 JSON 错误体：ApiError 保留码、文案与 details', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([JSON.stringify({ error: { code: 'BUDGET_GUARD_UNAVAILABLE', message: '预算拦住', details: { budget: 1 } } })], {
        status: 409,
        contentType: 'application/json',
      }),
    );
    const { handlers } = recorder();
    const error = await streamAiProposal('chapter-1', payload, handlers, signal).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'BUDGET_GUARD_UNAVAILABLE',
      message: '预算拦住',
      details: { budget: 1 },
    });
  });

  it('HTTP 失败没有 JSON 错误体：归因 UNKNOWN 并带状态码兜底文案', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['<html>bad gateway</html>'], { status: 502 }));
    const { handlers } = recorder();
    await expect(streamAiProposal('chapter-1', payload, handlers, signal)).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'UNKNOWN',
      message: '生成请求失败（HTTP 502）',
    });
  });
});
