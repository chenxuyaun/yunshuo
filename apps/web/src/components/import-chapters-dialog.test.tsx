import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ImportChaptersDialog, parseManuscript } from './ImportChaptersDialog.js';

function headings(count: number): string {
  return Array.from({ length: count }, (_, index) => `## 第${index + 1}章 标题${index + 1}\n正文${index + 1}`).join(
    '\n\n',
  );
}

describe('parseManuscript', () => {
  it('按标题切章、去掉标题前导分隔符、丢正文首尾空行', () => {
    const result = parseManuscript(
      ['书名', '作者：某人', '', '## 第1章 · 旧城雨夜', '', '正文一。', '', '## 第2章：封印之前', '正文二。'].join(
        '\n',
      ),
    );

    expect(result.error).toBeNull();
    expect(result.preambleLines).toBe(2);
    expect(result.chapters).toEqual([
      { number: 1, title: '旧城雨夜', content: '正文一。' },
      { number: 2, title: '封印之前', content: '正文二。' },
    ]);
  });

  it('没有标题时给出格式指引', () => {
    const result = parseManuscript('只有正文\n没有章节标题');

    expect(result.chapters).toEqual([]);
    expect(result.preambleLines).toBe(2);
    expect(result.error).toBe('未识别到章节标题。请用「## 第1章 标题」作为每一章的开头。');
  });

  it('缺标题的章回退成「第N章」', () => {
    const result = parseManuscript('  ## 第7章   \n正文七');

    expect(result.error).toBeNull();
    expect(result.chapters).toEqual([{ number: 7, title: '第7章', content: '正文七' }]);
  });

  it('标题编号允许夹空格，目录层级 1–6 都算，4 个空格缩进不算', () => {
    expect(parseManuscript('### 第 2 章 别名\n正文').chapters[0]).toMatchObject({ number: 2, title: '别名' });
    expect(parseManuscript('#### 第3章 - 短横\n正文').chapters[0]).toMatchObject({ number: 3, title: '短横' });
    expect(parseManuscript('###### 第4章 尾级\n正文').chapters[0]).toEqual({
      number: 4,
      title: '尾级',
      content: '正文',
    });
    expect(parseManuscript('    ## 第5章 缩进\n正文').error).toBe(
      '未识别到章节标题。请用「## 第1章 标题」作为每一章的开头。',
    );
  });

  it('CRLF 与单独 CR 都归一，正文不带回车', () => {
    const crlf = parseManuscript('## 第1章 一\r\n正文\r\n## 第2章 二\r\n正文二');
    const cr = parseManuscript('## 第1章 一\r正文\r## 第2章 二\r正文二');

    expect(crlf.chapters.map((chapter) => chapter.content)).toEqual(['正文', '正文二']);
    expect(cr.chapters.map((chapter) => chapter.content)).toEqual(['正文', '正文二']);
    expect(crlf.chapters.some((chapter) => chapter.content.includes('\r'))).toBe(false);
  });

  it('纯空白的前言行不计数', () => {
    const result = parseManuscript('\n  \n\t\n## 第1章 一\n正文');

    expect(result.preambleLines).toBe(0);
    expect(result.error).toBeNull();
  });

  it('章节号重复优先报重复，并排序列出', () => {
    const result = parseManuscript('## 第3章 甲\nA\n## 第2章 乙\nB\n## 第3章 丙\nC\n## 第2章 丁\nD');

    expect(result.chapters).toEqual([]);
    expect(result.error).toBe('章节号重复：2、3');
  });

  it('编号越界与正文为空归为非法', () => {
    const zero = parseManuscript('## 第0章 零\n正文');
    const tooBig = parseManuscript('## 第100000章 超\n正文');
    const emptyBody = parseManuscript('## 第1章 空');
    const both = parseManuscript('## 第0章 零\n正文\n## 第1章 空');

    expect(zero.error).toBe('以下章节号非法或正文为空：0');
    expect(tooBig.error).toBe('以下章节号非法或正文为空：100000');
    expect(emptyBody.error).toBe('以下章节号非法或正文为空：1');
    expect(both.error).toBe('以下章节号非法或正文为空：0、1');
  });

  it('超过 1000 章拒绝，1000 章放行', () => {
    const ok = parseManuscript(headings(1000));
    const over = parseManuscript(headings(1001));

    expect(ok.error).toBeNull();
    expect(ok.chapters.length).toBe(1000);
    expect(over.chapters).toEqual([]);
    expect(over.error).toBe('一次最多导入 1000 章，请拆分后重试。');
  });
});

function render(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ImportChaptersDialog onClose={() => {}} onImported={() => {}} />
    </QueryClientProvider>,
  );
}

describe('ImportChaptersDialog', () => {
  it('弹窗骨架与迁移口径说明', () => {
    const html = render();

    expect(html.startsWith('<div class="modal-backdrop">')).toBe(true);
    expect(html).toContain('class="modal modal-import"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="import-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<header class="modal-head">');
    expect(html).toContain('<p class="eyebrow">迁移导入 · 门禁未评估</p>');
    expect(html).toContain('<h2 id="import-title">导入旧章</h2>');
    expect(html).toContain('<button type="button" class="modal-close">关闭</button>');
    expect(html).toContain('<div class="modal-body import-body">');
    expect(html).toContain(
      '把旧稿作为“迁移导入”版本写入正典。导入章不会补造门禁结论，界面显示“未评估”；需要时再走修订、门禁与提交链。一次导入一个卷。',
    );
    expect(html).toContain(
      '已配置启用的嵌入服务时，导入章会自动排队建立索引，可能产生嵌入调用费用；未配置时只显示“未配置嵌入服务”，可稍后重建。',
    );
  });

  it('三个元数据字段带默认值与上限', () => {
    const html = render();

    expect(html).toContain('<div class="field-grid">');
    expect(html).toContain('<span>作品名</span>');
    expect(html.match(/maxLength="200"/g)?.length).toBe(2);
    expect(html).toContain('placeholder="例如：规则档案馆"');
    expect(html).toContain('<span>卷号</span>');
    expect(html).toContain('<input type="number" min="1" max="999" value="1"/>');
    expect(html).toContain('<span>卷名</span>');
    expect(html).toContain('placeholder="例如：第一卷 · 旧城"');
    expect(html).toContain('value="第一卷"');
    expect(html).toContain('class="field import-volume-number"');
  });

  it('正文来源区接受文件也接受粘贴，初始没有文件名', () => {
    const html = render();

    expect(html).toContain('<section class="import-source">');
    expect(html).toContain('<div class="field-head">');
    expect(html).toContain('<span>旧稿正文</span>');
    expect(html).toContain('支持 UTF-8 的 .md / .txt；章节标题格式：## 第1章 标题');
    expect(html).toContain('<input type="file" accept=".md,.markdown,.txt,text/plain" class="import-file"/>');
    expect(html).not.toContain('已读取文件：');
    expect(html).toContain('<textarea rows="12"');
    expect(html).toContain('## 第1章 旧城雨夜');
    expect(html).toContain('## 第2章 封印之前');
  });

  it('初始没有错误行与预览区', () => {
    const html = render();

    expect(html).not.toContain('class="modal-error"');
    expect(html).not.toContain('import-preview');
    expect(html).not.toContain('识别到');
  });

  it('底部三个按钮：解析与导入先禁用，取消可用', () => {
    const html = render();

    expect(html).toContain('<footer class="modal-foot">');
    expect(html.match(/type="button" class="button button-quiet"/g)?.length).toBe(2);
    expect(html).toContain('取消</button>');
    expect(html).toContain('disabled="">解析预览</button>');
    expect(html).toContain('disabled="">导入</button>');
    expect(html).toContain('<button type="button" class="button button-primary" disabled="">导入</button>');
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});
