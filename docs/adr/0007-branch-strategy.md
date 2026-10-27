# ADR-0007：基座另起分支还是续用当前分支

- **状态**：待拍板（Proposed）
- **来源**：分层设计 D7
- **阻塞**：**L0（硬阻塞）**——本 ADR 是唯一一条"不定就没法开工"的决策
- **建议**：**本 ADR 不给建议。** 设计文档在 D7 上没有写倾向，这里也不替它发明一个。只把现状、选项与代价摆出来。

## 现状（2026-10-26 实测，与设计文档写 D7 时已不同）

设计文档 D7 的原文是"现在这条分支的 P0 改动仍未提交、PR #7 已合并进 main"。前一半仍然成立，后一半需要更正与补全：

| 事实 | 实测结果 |
| --- | --- |
| PR #7 状态 | **已合并**。`origin/main` 的 tip 是 `35412eb`（`Merge pull request #7 from chenxuyaun/feat/m6-7-ledger-suggestions`） |
| 当前分支与 main 的关系 | 当前分支 HEAD `c816acb` **是 `origin/main` 的祖先**——分支上所有**已提交**内容都已在 main 里。origin/main 比 HEAD 多的唯一一个提交就是 PR #7 的 merge commit 本身 |
| 本地 `main` | 停在 `bed54c5`，落后于 `origin/main`（本地 main 是陈旧引用，不是真相） |
| 未提交的工作区改动 | **62 项**。其中包含**整个 P0 动线**：迁移 `0021_plan_and_structure.sql`、`apps/api/src/routes/plan.ts`、`routes/works.ts`、`services/plan-service.ts`、`services/work-structure-service.ts`、`packages/domain/src/plan.ts`、`apps/web/src/components/PlanDialog.tsx`、`WorkStructureDialog.tsx`、`apps/web/src/plan.ts`、两个前端测试文件、`scripts/schema-drift.mjs`，以及 `AGENTS.md`、`docs/adr/`、四份设计文档 |
| 另有未跟踪目录 | `.mimosa/`（安全钩子的会话状态产物，与代码无关，不应进版本库） |

**要点：P0 的代码与迁移已经在工作区里，且尚未提交到任何分支。** 这是 D7 真正的约束——不是"分支脏了"，而是"有一批已完成但未落盘的改动等着归位"。

## 选项

### (a) 基座另起分支（从 `origin/main` 切）

- 做法：先把 P0 工作区的改动在**当前分支**上提交并开 PR；PR 合并后，从新的 `origin/main` 切一条基座分支。
- 代价：P0 的 PR 要先走一遍评审与合并；L0 开工时间后移到 P0 落地之后。
- 收益：基座从一条干净的 main 起，`runs` / `steps` / `tool_calls` 这些新表的迁移编号不与未落盘的 `0021` 抢位；P0 与基座两件事各自可回退。

### (b) 续用当前分支

- 做法：P0 的改动在当前分支上提交，基座继续往这条分支上叠。
- 代价：**一条分支同时承载"P0 动线交付"与"L0–L7 基座施工"两件事**，与 `AGENTS.md` 硬规则 13（"一个 PR 聚焦一件事"）直接冲突；P0 的评审会把基座一起带进来，或者反过来基座的返工牵动 P0 的合并。
- 收益：不用等，P0 与 L0 可以连着做。

### (c) 在当前分支上先提交 P0，然后**同分支改名/重开**为基座分支

- 做法：P0 先提交、开 PR、合并；然后**不新建分支**，继续在这条已合并的分支上加基座（等价于 (a) 但省掉切分支动作）。
- 差别：与 (a) 的实际效果几乎相同，区别只在分支名是否还叫 `feat/m6-7-ledger-suggestions`。分支名会误导后来者以为这里只有 M6-7。

## 拍这条 ADR 时要一起定的两件事

1. **P0 的改动先提交还是先放着。** 62 项里混着 P0 代码、四份设计文档、`AGENTS.md`、`scripts/schema-drift.mjs` 与 `docs/adr/`。按硬规则 13，这些至少该拆成"P0 动线实现"与"闸门 + 文档"两个提交，而不是一次全推。
2. **`.mimosa/` 要不要进 `.gitignore`。** 它是钩子状态，不属于仓库内容。当前它不在 `.gitignore` 里，`git add -A` 会把它带进去。

## 回退

分支策略本身没有"回退"——它只有"还没定"与"定了"。定了之后若要改（例如发现基座不该压在这条分支上），代价是 rebase 或重开分支，越晚越贵。这是它必须**先**拍的原因。
