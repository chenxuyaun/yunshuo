# 贡献指南

感谢参与云说。这个项目的核心不是“让 AI 多写一点”，而是让每一章都经过可追溯的人工提交链，所以请先阅读 [README.md](README.md) 的“核心原则”和“诚实边界”。

## 开始之前

- 较大的功能或架构改动，先开 issue 说明目标、边界与验收方式，避免直接提交大 PR。
- 安全问题不要公开提 issue，请按 [SECURITY.md](SECURITY.md) 私密报告。
- 不接受以占位界面冒充已接入功能，也不接受伪造的成功、数据或 `ready` 索引。

## 开发环境

前置条件：Node.js 24、pnpm 10.33.0、Docker（用于 PostgreSQL 17 + pgvector）。

```bash
pnpm install
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- Web: <http://localhost:5173>
- API: <http://localhost:3100>
- Postgres: `localhost:5433`

开发登录依赖 `DEV_AUTH=1`，仅限本机。种子用户没有默认密码；需要密码账号时通过邀请接受或“忘记密码”创建。

## 测试

集成测试会写入真实数据库，**必须使用独立测试库 `yunshuo_test`**，不要与开发 API 共用主库。测试库只需建一次：

```bash
docker exec yunshuo-db createdb -U yunshuo yunshuo_test

export DATABASE_URL=postgres://yunshuo:yunshuo@localhost:5433/yunshuo_test
export TEST_DATABASE_URL=$DATABASE_URL

pnpm db:migrate
pnpm db:seed
pnpm test
```

Windows 下请在 PowerShell 或 cmd 中设置同名的 `DATABASE_URL` 与 `TEST_DATABASE_URL` 环境变量。

常用检查：

```bash
pnpm typecheck
pnpm test
pnpm check:endpoints
pnpm check:error-codes
pnpm check:schema-drift
```

三个 `check:*` 是自建的静态闸门，不需要数据库，本地几秒内跑完：

- `check:endpoints` —— 每条路由都要被测试引用过 URL 形状，否则失败。
- `check:error-codes` —— 每个错误码都要有测试断言，否则失败。
- `check:schema-drift` —— 迁移（唯一真相）与 `packages/db/src/schema.ts` 的表名/列名必须一致，否则失败。

三个闸门都带**双向过期检查**：允许清单里已经失效的条目同样报错，所以不要把它当永久免检通行证。

CI 会在 push 到 `main` 和 pull request 时执行同样的步骤：启动 PostgreSQL 17 + pgvector、迁移、种子、类型检查、三个静态闸门、全量测试。提交 PR 前请确保本地或 CI 通过。

前端有独立的自动化测试：`apps/web` 下 42 个测试文件 / 341 项（vitest，不装 jsdom），用 `renderToStaticMarkup` 断言渲染输出，交互逻辑抽到 `plan.ts` 这类纯模块里单独断言。注意浏览器代码不要从 `@yunshuo/domain` 这个 barrel 取运行时值——它会带进 `node:crypto`，类型检查能过但浏览器整页白屏；`apps/web/src/browser-imports.test.ts` 会拦下这种写法。

## 数据库与迁移

- 迁移文件位于 `packages/db/migrations/`，按序号命名，例如 `0015_xxx.sql`。
- **不要修改已经执行过的迁移**；新增结构变更请添加新迁移。
- 同步更新 `packages/db/src/schema.ts`、相关契约与测试，然后运行 `pnpm check:schema-drift`。`schema.ts` 没有运行时调用方（所有查询都走 postgres.js 的 `sql` 模板），它漂移了不会有任何测试变红，只能靠这个闸门兜住。
- 涉及并发、唯一约束或权限边界的变更，请补充集成测试，而不是只改 SQL。
- 测试数据必须自行创建并清理，不要依赖或改写演示作品。

## 代码约定

- TypeScript + ESM，保持现有的严格类型与模块边界。
- 项目暂无独立 lint 脚本；请沿用现有文件风格，提交前运行 `pnpm typecheck`。
- 新增依赖前先说明必要性，避免为小功能引入大依赖。
- API 边界使用 Zod 校验；错误使用现有 `AppError` 错误码，不把上游敏感信息直接返回给浏览器。
- 所有工作区数据访问都必须带工作区隔离；新增角色或入口时同时检查后端权限。
- 前端沿用现有 React 19 + TanStack Query + 原生 CSS 结构，不引入并行状态方案。
- 不提交 `.env`、`.env.studio`、`backups/`、密钥、真实邮箱或真实用户数据。仓库只保留 `.env.example` 与 `.env.studio.example`。

## 必须遵守的领域不变量

- AI 不能直接写草稿或正典，也不能申请或批准豁免；豁免申请人不能是批准人。M6-7 的账本建议同样遵守：模型输出只落到 `ledger_suggestions`，草稿必须由人类点“采纳”后经 `saveLedgerDraft` 写入，且采纳不改当前版本、不入队索引；AI 主体对四个建议端点都没有写权限。
- 无人值守作业只在所有者/主笔显式授权后运行，任一门禁失败都不得入库。
- 未接入的能力显示“未接入”；无嵌入服务时索引显示“未配置”；导入章节的门禁是“未评估”。
- 不伪造成功、数据、费用或 `ready` 索引；成本缺失或无法计算时显示未知。
- `dev-v0` 是演示规则集，不是生产标准。
- 服务商密钥、邀请令牌、重置令牌与密码不得以明文进入数据库、日志或审计。
- 临时 mock 服务商与测试数据在使用后必须清理，不能留作演示内容。

## 提交 PR

- 一个 PR 聚焦一件事，避免把重构、功能和格式化混在一起。
- 行为变更请补测试；用户可见变化请同步更新 README 或 `docs/`。
- PR 描述请写清：改了什么、为什么改、如何验证、已知边界或风险。
- Commit message 使用简洁的祈使句，中文或英文均可，例如 `修复导入卷名冲突`。
- 合并前确保 CI 通过。维护者可能要求补充测试、收敛范围或拆分 PR。

## 许可证

本项目使用 [AGPL-3.0](LICENSE)。提交贡献即表示你同意该贡献按同一许可证发布。
