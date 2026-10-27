# ADR-0002：工具定义放哪

- **状态**：待拍板（Proposed）
- **来源**：分层设计 D2
- **阻塞**：L1a
- **建议**：选项 (a)

## 背景

L1a 要交 2 个只读工具，L1b 再补 3 个。工具定义（名字、描述、`inputSchema`、handler）需要一个归属地，而且这份定义**必须一处写、多处用**——API 要调它、将来的 MCP server 要把同一份定义抬出去、测试要直接断言它。分散定义会让"注册表"名存实亡。

## 选项

**(a) 新建 `packages/tool-surface`。**

**(b) 塞进 `packages/domain`。**

## 建议与理由

**(a)**。理由：`packages/domain` 现在装的是**纯函数**（无 IO，见 `AGENTS.md` 的仓库地图），工具定义天然带 handler 与 IO 边界，塞进去会破坏它现有的纯度契约——而"domain 无 IO"这条正是前端能从它取纯函数的依据。工具面要同时服务 API、（将来）MCP 与测试，是三方的公共契约，值得独立一格。

## 如果采纳，影响面

（以下按实施时核过的仓库现状写，不是按当初的推测写。）

- **新增第 7 个 `packages/*` 包**：workspace 项目从 10 变 11（含根工程）。
  `pnpm typecheck` 从 9/9 变 **10/10**，而 `pnpm typecheck` 实际打印的 Scope 行是 **`10 of 11`**——分母含根工程，根不参与 `-r`。
- **不需要改的两处（当初写错了）**：
  - 仓库**根本没有根 `tsconfig.json`**（只有 `tsconfig.base.json`），全仓库零 `references`，各项目独立 `tsc --noEmit`；新包只需 `extends ../../tsconfig.base.json`。
  - `pnpm-workspace.yaml` 是 `packages/*` 通配，新扁平目录自动被收录，**不需要改**。
- **真正要改的地方**：
  - `apps/api/package.json` 加 `"@yunshuo/tool-surface": "workspace:*"`（绑定层在 API 侧）。
  - `pnpm-lock.yaml` 重新生成：新增一个 importer、`apps/api` 多一条 link。仓库有三处 `--frozen-lockfile`（CI 的 install 与两个 Dockerfile 的 deps 阶段），不改 lockfile 会在第一道安装就失败。
  - `deploy/api.Dockerfile` 与 `deploy/web.Dockerfile` 的 deps 阶段各补一行 `COPY packages/tool-surface/package.json …`（按字母序放在 `retrieval` 之后）。漏了这行会让 deps 阶段的 `pnpm install --frozen-lockfile` 失败（lockfile 里有这个 importer，镜像里却没有对应的包）；本批新增的 CI `docker-build` job（`.github/workflows/ci.yml`，只构建不推送）会在 CI 里报红——在该 job 之前，这类问题只有 `docker compose ... build` 时才撞得上。
- 工具的 handler 必须收 `AuthContext` 并自己判主体（见威胁模型 §5.2：AI 禁令是逐操作的，漏加不会变红）。本仓库的落点是 `apps/api/src/tools/bind.ts` 的键名→handler 表：handler 签名里没有 `AuthContext` 就过不了 typecheck；角色闸门与跨工作区 404 各自写在 handler 内。
- 前端若要展示工具状态，只能从纯子路径取类型；`@yunshuo/domain` 那个 barrel 陷阱的教训同样适用（浏览器代码不许从 barrel 取运行时值）。

## 为什么不选「全部放 apps/api」

事实依据（不是偏好）：

- 工具定义要同时服务 API、将来的 MCP server 与测试。定义住在 `apps/api` 的话，MCP 侧复用它就得**依赖整个 API 服务**（连同 `@yunshuo/db` 连接、`env`、权限栈的模块副作用），或者**复制一份定义**——而两份定义漂移时没有闸门能发现。仓库已经有先例：`packages/db/src/schema.ts` 漂移后没有任何测试变红，最后靠 `pnpm check:schema-drift` 才钉住。
- 新包的依赖面很小，可核验：`grep -rn "from '" packages/tool-surface/src` 的结果只有 `zod`（运行时唯一依赖）、包内相对路径与测试文件里的 `vitest`（devDependency，不进运行时依赖），没有任何 app 依赖；`AuthContext`→服务函数的适配留在 `apps/api/src/tools/bind.ts`（`AuthContext` 本来就在 API 侧，包不反向依赖它）。
- 代价是「多一个包」的固定成本（lockfile、两行 Dockerfile、一次计数更新），换来的是定义不受 API 进程的加载副作用牵连。这个包在 L1a 只装 2 个工具，但它同时是 L2 与 L6 的取用点，不是只为这一次交付存在的。

## 回退

L1a 塌了（2 个工具的描述与 schema 反复改仍不可靠）就停在 2 个，L1b 不开，其余回代码预装配。
停在这一步**不需要撤销任何东西**：包、注册表、lockfile 与两行 Dockerfile 都是中性的，注册表结构按 5 个设计，后续追加不返工。

彻底删掉这个包（而不是停用）需要同时做四件事，漏一件就会红：删 `packages/tool-surface`、删 `apps/api/package.json` 的依赖、重新生成 `pnpm-lock.yaml`、删两个 Dockerfile 的那行 COPY；另外把 `AGENTS.md` 的 typecheck 计数改回 `9/9`。
