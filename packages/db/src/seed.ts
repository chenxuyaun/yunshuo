import { countWords, sha256 } from '@yunshuo/domain';
import {
  DEV_RULESET,
  DEV_RULESET_DESCRIPTION,
  DEV_RULESET_ID,
  DEV_RULESET_KEY,
  DEV_RULESET_VERSION,
} from '@yunshuo/gates';
import postgres from 'postgres';
import { loadEnv, requireEnv } from './env.js';
import { jsonValue } from './json.js';

loadEnv();

const sql = postgres(requireEnv('DATABASE_URL'), { max: 1, onnotice: () => undefined });

const ids = {
  workspace: '11111111-1111-4111-8111-111111111111',
  owner: '22222222-2222-4222-8222-222222222222',
  author: '33333333-3333-4333-8333-333333333333',
  lead: '44444444-4444-4444-8444-444444444444',
  work: '55555555-5555-4555-8555-555555555555',
  volume: '66666666-6666-4666-8666-666666666666',
  chapterImported: '77777777-7777-4777-8777-777777777777',
  chapterNext: '88888888-8888-4888-8888-888888888888',
  importedVersion: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;

const importedContent = `旧城的雨下了七天。林默把最后一张封印符按进门框，指尖被木刺划出一道血线。他必须在追兵赶到之前完成封印，否则整条街都会变成祭坛。

门外传来脚步声。林默没有回头，只把最后一枚铜钉咬在齿间。

“还差一枚。”他低声说。`;

const importedHash = sha256(importedContent);
const importedWordCount = countWords(importedContent);

const plan = {
  requiredEntities: ['林默'],
  goalKeywords: ['封印'],
  obstacleKeywords: ['追兵'],
};

try {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO users (id, email, name)
      VALUES
        (${ids.owner}, 'owner@demo.local', '周所有者'),
        (${ids.author}, 'author@demo.local', '林编辑'),
        (${ids.lead}, 'lead@demo.local', '沈主笔')
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO workspaces (id, name, settings_version, ledger_version)
      VALUES (${ids.workspace}, '演示工作区', 1, 1)
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES
        (${ids.workspace}, ${ids.owner}, 'owner'),
        (${ids.workspace}, ${ids.author}, 'author'),
        (${ids.workspace}, ${ids.lead}, 'lead')
      ON CONFLICT (workspace_id, user_id) DO NOTHING
    `;

    await tx`
      INSERT INTO works (id, workspace_id, title)
      VALUES (${ids.work}, ${ids.workspace}, '演示作品 · 主流程验证')
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${ids.volume}, ${ids.work}, 1, '第一卷 · 演示')
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO gate_rulesets (id, key, version, description, rules, is_production)
      VALUES (
        ${DEV_RULESET_ID},
        ${DEV_RULESET_KEY},
        ${DEV_RULESET_VERSION},
        ${DEV_RULESET_DESCRIPTION},
        ${tx.json(jsonValue(DEV_RULESET))},
        false
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan)
      VALUES
        (${ids.chapterImported}, ${ids.work}, ${ids.volume}, 1, '旧城雨夜', 'canon', ${tx.json(jsonValue(plan))}),
        (${ids.chapterNext}, ${ids.work}, ${ids.volume}, 2, '封印之前', 'planned', ${tx.json(jsonValue(plan))})
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count,
        parent_version_id, source, actor_id, evaluation_id, waiver_id
      )
      VALUES (
        ${ids.importedVersion}, ${ids.chapterImported}, 1, ${importedContent},
        ${importedHash}, ${importedWordCount}, NULL, 'import', ${ids.owner}, NULL, NULL
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO canon_current (chapter_id, version_id)
      VALUES (${ids.chapterImported}, ${ids.importedVersion})
      ON CONFLICT (chapter_id) DO NOTHING
    `;

    await tx`
      UPDATE chapters
      SET status = 'canon', current_version_id = ${ids.importedVersion}, updated_at = now()
      WHERE id = ${ids.chapterImported}
    `;

    await tx`
      INSERT INTO chapter_metadata (chapter_id, word_count)
      VALUES (${ids.chapterImported}, ${importedWordCount})
      ON CONFLICT (chapter_id) DO NOTHING
    `;

    await tx`
      INSERT INTO index_status (chapter_id, version_id, status, detail)
      VALUES (${ids.chapterImported}, ${ids.importedVersion}, 'not_configured', '尚未配置嵌入服务商；正典已导入，可在检索面板重建索引')
      ON CONFLICT (chapter_id) DO NOTHING
    `;

    await tx`
      INSERT INTO events (workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
      VALUES (
        ${ids.workspace}, 'chapter', ${ids.chapterImported}, 'chapter.imported',
        ${tx.json(jsonValue({ versionId: ids.importedVersion, source: 'import' }))},
        ${ids.owner}
      )
    `;

    await tx`
      INSERT INTO audit_log (workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata)
      VALUES (
        ${ids.workspace}, ${ids.owner}, 'human', 'owner', 'chapter.import', 'chapter', ${ids.chapterImported},
        'success', ${tx.json(jsonValue({ versionId: ids.importedVersion, evidence: 'not_evaluated' }))}
      )
    `;
  });

  console.log('seed complete');
  console.log('demo users: owner@demo.local / author@demo.local / lead@demo.local');
  console.log('demo work: 演示作品 · 主流程验证 (chapter 1 imported, chapter 2 planned)');
} finally {
  await sql.end({ timeout: 5 });
}
