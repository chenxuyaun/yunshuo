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

- **新增第 10 个 workspace 包**。连带要改的地方：根 `tsconfig` 引用、`pnpm-workspace.yaml`（若按目录枚举）、以及 `AGENTS.md:45` 与 `CONTRIBUTING.md` 里"9/9 workspace 项目"这个数字——`pnpm typecheck` 会从 9/9 变 10/10。
- 工具的 handler 必须收 `AuthContext` 并自己判主体（见威胁模型 §5.2：AI 禁令是逐操作的，漏加不会变红）。
- 前端若要展示工具状态，只能从纯子路径取类型；`@yunshuo/domain` 那个 barrel 陷阱的教训同样适用（浏览器代码不许从 barrel 取运行时值）。

## 回退

L1a 塌了（2 个工具的描述与 schema 反复改仍不可靠）就停在 2 个，L1b 不开，其余回代码预装配。这个包本身可以留着只装 2 个工具——它的存在不欠债。
