import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ImportChaptersInput } from '@yunshuo/contracts';
import { ApiError, importChapters } from '../api.js';

interface Props {
  onClose: () => void;
  onImported: (chapterId: string) => void;
}

interface ParsedChapter {
  number: number;
  title: string;
  content: string;
}

interface ParseResult {
  chapters: ParsedChapter[];
  preambleLines: number;
  error: string | null;
}

const HEADING_PATTERN = /^\s{0,3}#{1,6}\s*第\s*([0-9]+)\s*章\s*(.*?)\s*$/;

function parseManuscript(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters: ParsedChapter[] = [];
  let preambleLines = 0;
  let current: { number: number; title: string; lines: string[] } | null = null;

  function finish(): void {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    chapters.push({
      number: current.number,
      title: current.title || `第${current.number}章`,
      content,
    });
  }

  for (const line of lines) {
    const match = HEADING_PATTERN.exec(line);
    if (match) {
      finish();
      const number = Number(match[1]);
      const title = (match[2] ?? '').replace(/^[\s·:：\-—]+/, '').trim();
      current = { number, title, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      preambleLines += 1;
    }
  }
  finish();

  if (chapters.length === 0) {
    return {
      chapters: [],
      preambleLines,
      error: '未识别到章节标题。请用「## 第1章 标题」作为每一章的开头。',
    };
  }
  const numbers = new Set<number>();
  const duplicates = new Set<number>();
  const invalid = new Set<number>();
  for (const chapter of chapters) {
    if (!Number.isInteger(chapter.number) || chapter.number < 1 || chapter.number > 99_999) {
      invalid.add(chapter.number);
    }
    if (numbers.has(chapter.number)) duplicates.add(chapter.number);
    numbers.add(chapter.number);
    if (!chapter.content) invalid.add(chapter.number);
  }
  if (duplicates.size > 0) {
    return {
      chapters: [],
      preambleLines,
      error: `章节号重复：${[...duplicates].sort((a, b) => a - b).join('、')}`,
    };
  }
  if (invalid.size > 0) {
    return {
      chapters: [],
      preambleLines,
      error: `以下章节号非法或正文为空：${[...invalid].join('、')}`,
    };
  }
  if (chapters.length > 1000) {
    return { chapters: [], preambleLines, error: '一次最多导入 1000 章，请拆分后重试。' };
  }
  return { chapters, preambleLines, error: null };
}

function errorText(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

export function ImportChaptersDialog({ onClose, onImported }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [workTitle, setWorkTitle] = useState('');
  const [volumeNumber, setVolumeNumber] = useState(1);
  const [volumeTitle, setVolumeTitle] = useState('第一卷');
  const [manuscript, setManuscript] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, submitting]);

  function resetParse(): void {
    setParsed(null);
    setError(null);
  }

  function handleManuscriptChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setManuscript(event.target.value);
    setFileName(null);
    resetParse();
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > 18 * 1024 * 1024) {
      setError('文件超过 18MB，请拆分后再导入。');
      event.target.value = '';
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        setError('文件不是有效的 UTF-8 编码。请先转成 UTF-8 再导入，避免旧稿乱码入库。');
        event.target.value = '';
        return;
      }
      setManuscript(text);
      setFileName(file.name);
      resetParse();
    } catch (readError) {
      setError(`读取文件失败：${errorText(readError)}`);
    } finally {
      event.target.value = '';
    }
  }

  function handleParse(): void {
    if (!workTitle.trim()) {
      setError('请先填写作品名。');
      return;
    }
    if (!volumeTitle.trim()) {
      setError('请先填写卷名。');
      return;
    }
    const result = parseManuscript(manuscript);
    setParsed(result);
    setError(result.error);
  }

  async function handleImport(): Promise<void> {
    if (!parsed || parsed.chapters.length === 0) {
      setError('请先解析并确认章节。');
      return;
    }
    if (!workTitle.trim() || !volumeTitle.trim()) {
      setError('请填写作品名与卷名。');
      return;
    }
    const input: ImportChaptersInput = {
      workTitle: workTitle.trim(),
      volumeNumber,
      volumeTitle: volumeTitle.trim(),
      chapters: parsed.chapters.map((chapter) => ({
        number: chapter.number,
        title: chapter.title,
        content: chapter.content,
      })),
    };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    if (payloadBytes > 20 * 1024 * 1024) {
      setError('导入内容超过 20MB 请求体上限，请拆分后重试。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await importChapters(input);
      await queryClient.invalidateQueries({ queryKey: ['chapters'] });
      const first = response.imported[0];
      if (first) onImported(first.id);
      else onClose();
    } catch (importError) {
      setError(errorText(importError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="modal modal-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">迁移导入 · 门禁未评估</p>
            <h2 id="import-title">导入旧章</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} disabled={submitting}>
            关闭
          </button>
        </header>

        <div className="modal-body import-body">
          <p className="team-intro">
            把旧稿作为“迁移导入”版本写入正典。导入章不会补造门禁结论，界面显示“未评估”；需要时再走修订、门禁与提交链。一次导入一个卷。
          </p>
          <p className="muted">
            已配置启用的嵌入服务时，导入章会自动排队建立索引，可能产生嵌入调用费用；未配置时只显示“未配置嵌入服务”，可稍后重建。
          </p>

          <div className="field-grid">
            <label className="field">
              <span>作品名</span>
              <input
                value={workTitle}
                maxLength={200}
                placeholder="例如：规则档案馆"
                onChange={(event) => {
                  setWorkTitle(event.target.value);
                  resetParse();
                }}
              />
            </label>
            <label className="field import-volume-number">
              <span>卷号</span>
              <input
                type="number"
                min={1}
                max={999}
                value={volumeNumber}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setVolumeNumber(Number.isFinite(next) ? Math.max(1, Math.min(999, Math.trunc(next))) : 1);
                  resetParse();
                }}
              />
            </label>
            <label className="field">
              <span>卷名</span>
              <input
                value={volumeTitle}
                maxLength={200}
                placeholder="例如：第一卷 · 旧城"
                onChange={(event) => {
                  setVolumeTitle(event.target.value);
                  resetParse();
                }}
              />
            </label>
          </div>

          <section className="import-source">
            <div className="field-head">
              <span>旧稿正文</span>
              <span className="muted">支持 UTF-8 的 .md / .txt；章节标题格式：## 第1章 标题</span>
            </div>
            <input
              type="file"
              accept=".md,.markdown,.txt,text/plain"
              className="import-file"
              onChange={(event) => void handleFile(event)}
              disabled={submitting}
            />
            {fileName ? <span className="muted">已读取文件：{fileName}</span> : null}
            <textarea
              rows={12}
              value={manuscript}
              placeholder={'## 第1章 旧城雨夜\n正文……\n\n## 第2章 封印之前\n正文……'}
              onChange={handleManuscriptChange}
              disabled={submitting}
            />
          </section>

          {error ? <div className="modal-error">{error}</div> : null}

          {parsed && parsed.error === null ? (
            <section className="import-preview">
              <div className="import-preview-head">
                <strong>识别到 {parsed.chapters.length} 章</strong>
                <span className="muted">
                  共约 {parsed.chapters.reduce((sum, chapter) => sum + chapter.content.length, 0)} 字符
                </span>
              </div>
              {parsed.preambleLines > 0 ? (
                <p className="import-warning">
                  首个章节标题之前有 {parsed.preambleLines} 行内容，不会导入。若那是书名或作者信息，请先确认。
                </p>
              ) : null}
              <ul className="import-list">
                {parsed.chapters.slice(0, 12).map((chapter) => (
                  <li key={chapter.number}>
                    <span className="mono">第 {chapter.number} 章</span>
                    <span>{chapter.title}</span>
                    <span className="muted">{chapter.content.length} 字符</span>
                  </li>
                ))}
              </ul>
              {parsed.chapters.length > 12 ? (
                <p className="muted">另有 {parsed.chapters.length - 12} 章未在预览中展开。</p>
              ) : null}
            </section>
          ) : null}
        </div>

        <footer className="modal-foot">
          <button
            type="button"
            className="button button-quiet"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="button button-quiet"
            onClick={handleParse}
            disabled={submitting || manuscript.trim().length === 0}
          >
            解析预览
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void handleImport()}
            disabled={submitting || !parsed || parsed.chapters.length === 0}
          >
            {submitting ? '导入中…' : parsed ? `导入 ${parsed.chapters.length} 章` : '导入'}
          </button>
        </footer>
      </div>
    </div>
  );
}
