import type { AuditResult } from '@yunshuo/domain';

const SENSITIVE_WORDS = ['色情', '赌博', '毒品', '暴力', '恐怖袭击'];
const AI_TONE_PHRASES = ['仿佛', '不禁', '嘴角勾起', '眸子'];

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function collectWords(
  text: string,
  words: string[],
): { hits: number; examples: string[] } {
  const found = words
    .map((word) => ({ word, count: countOccurrences(text, word) }))
    .filter((item) => item.count > 0);
  return {
    hits: found.reduce((sum, item) => sum + item.count, 0),
    examples: found.map((item) => `${item.word}×${item.count}`),
  };
}

export function runAudits(content: string): AuditResult[] {
  const halfWidthPunctuation = content.match(
    /[,.;:!?](?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])[,.;:!?]/g,
  );
  const punctuationExamples = Array.from(new Set(halfWidthPunctuation ?? [])).slice(0, 8);

  const sensitive = collectWords(content, SENSITIVE_WORDS);
  const aiTone = collectWords(content, AI_TONE_PHRASES);

  return [
    {
      key: 'ai_flavor',
      label: 'AI 味量化',
      status: aiTone.hits > 0 ? 'warning' : 'ok',
      message:
        aiTone.hits > 0
          ? `命中 ${aiTone.hits} 处 AI 腔调短语；仅提示，不改写正文。`
          : '演示短语表未命中；生产检测器尚未接入。',
      hits: aiTone.hits,
      examples: aiTone.examples,
      advisoryOnly: true,
    },
    {
      key: 'typos',
      label: '错别字',
      status: 'not_connected',
      message: '错别字检测器未接入（当前不含词典/模型检测）。',
      advisoryOnly: true,
    },
    {
      key: 'punctuation',
      label: '标点规范',
      status: punctuationExamples.length > 0 ? 'warning' : 'ok',
      message:
        punctuationExamples.length > 0
          ? `检测到中文语境中的半角标点 ${punctuationExamples.length} 类；仅提示。`
          : '未检测到中文语境中的半角标点。',
      hits: punctuationExamples.length,
      examples: punctuationExamples,
      advisoryOnly: true,
    },
    {
      key: 'sensitive_words',
      label: '敏感词',
      status: sensitive.hits > 0 ? 'warning' : 'ok',
      message:
        sensitive.hits > 0
          ? `命中 ${sensitive.hits} 处演示敏感词；仅提示，需人工复核。`
          : '演示敏感词表未命中；生产词表尚未接入。',
      hits: sensitive.hits,
      examples: sensitive.examples,
      advisoryOnly: true,
    },
    {
      key: 'coherence',
      label: '文内连贯度',
      status: 'not_connected',
      message: '文内连贯度检测器未接入（当前不含模型检测）。',
      advisoryOnly: true,
    },
  ];
}
