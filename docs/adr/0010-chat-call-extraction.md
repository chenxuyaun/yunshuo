# ADR-0010：chat 调用要不要抽进 `packages/model-gateway`

- **状态**：待拍板（Proposed）
- **来源**：分层设计 D10
- **阻塞**：L2b（作为其**前置小重构**）
- **建议**：(a) 抽进 `packages/model-gateway`

## 背景（实测）

`packages/model-gateway/src/index.ts` 目前只导出四样：`./secret.js`、`./embedding-client.js`、`./embedding-providers.js`、`./embedding-cost.js`。

也就是说 **Model Gateway 只做了一半**：嵌入侧在包里，chat 侧内联在 `apps/api/src/services/ai-service.ts`——`fetch(\`${provider.baseUrl}/chat/completions\`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', … })`（`:1166` 一带）。

D10 要决定的是：**这个不对称要不要在 L2b 之前补平。**

## 选项

### (a) 抽进 `packages/model-gateway`（推荐）

- 与嵌入侧对称：服务商细节（baseUrl、鉴权头、`redirect: 'error'`、超时、错误归一化）全部收在一个包里，循环不碰 provider 细节。
- 设计文档给的理由**不是美观**（`:132`）：循环会把"服务商细节 + 工具执行 + 状态推进"三件事挤进同一个文件。而架构师那句"更换模型供应商不应破坏任务状态和历史记录"，对本仓就是这条硬要求——provider 细节与 run 状态机必须在不同的模块里，才谈得上互不破坏。
- 它是 L2b 的前置，所以**放在 L2b 开工前做**，而不是与 L2b 混在一次改动里。

### (b) 留在 `ai-service.ts`

- 不动那条路径，零回归风险。
- 代价：L2b 落地时，"循环 + 工具执行 + provider 调用 + 状态推进"四件事在同一个文件里。设计文档把这种情况直接点成"会挤进同一个文件"——这是 L2b 最不该出现形态。

## 建议与理由

选 (a)，但**把它当一次独立的小重构做，验收口径是"行为等价"而不是"顺便把循环接上"**。

- **代价是真实的**：`ai-service.ts` 是一条被大量用例覆盖的路径（api 工作区 272 项测试里相当一部分围着生成、预算、failover、stale 回收）。改它等于在已有闸门最密的地方动刀。
- **所以验收必须钉在"现网 Atria 的真实调用口径不能变"**：请求体字段、`tool_choice` 缺席时的行为、错误码归一化、重试与 failover 顺序、`model_calls` 的写入位点与时机——**一样都不能变**。变了的任何一项都是回归，不是"重构的副产品"。
- 这次重构的产出物里，**必须包含一条能证明等价性的证据**（现有用例全绿 + 一条真实服务商跑通并如实记录 tokens/成本）。不能只说"我抽了包"。

## 影响面

- `packages/model-gateway` 从"嵌入专用"变成"chat + 嵌入"两侧共用；`index.ts` 的导出清单会新增 chat 侧入口。
- `ai-service.ts` 保留的职责：run/step 的推进、预算判定（`budgetMaxTokens` `:1045-1090`）、failover 循环（`:1356` 的 `while (providerIndex < run.providers.length && totalAttempts < MAX_TOTAL_ATTEMPTS)`）、`model_calls` 记账。
- **两条循环不要混**（`:136`）：`while (providerIndex …)` 是"这个服务商不行换一个"，agent 循环是"这次回答还要不要再取证据"。抽包时要把前者的归属讲清楚——它留在调用方还是进包，直接决定 L2b 里"一个 step 内部仍可 failover"是不是好实现。

## 回退

(a) 的回退是"把 chat 调用搬回 `ai-service.ts`"——因为验收口径是行为等价，搬回去不会留下行为差异。**这是它敢做的理由**：一次纯位移，位移前后应当逐字节等价地对外可见。

风险不在"能不能回退"，而在"会不会以为等价、实际不等价"。所以等价性证据是这次重构的交付物本身。
