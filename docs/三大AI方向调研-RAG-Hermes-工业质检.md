# 三大 AI 方向调研：企业级 RAG、Hermes 多 Agent、工业质检多模态

> 调研日期：2026-10-20
> 范围：概念澄清、代表项目、GitHub 实现拆解、可落地的技术路线
> 说明：公开资料中没有与“企业级RAG知识库（冠军方案）/ Hermes多Agent协作与调度 / AI工业质检（多模态对决）”完全同名的统一赛事或项目。根据公开资料，三者最可能分别对应：Enterprise RAG Challenge 冠军方案、Nous Research 的 Hermes Agent 多 Agent 运行时、以及以 MMAD 为代表的多模态大模型工业异常检测评测。本文按这三个方向展开。

---

## 0. 先给结论

| 方向 | 本质 | 工程成熟度 | 最值得先读的仓库 | 自研难度 |
| :--- | :--- | :--- | :--- | :--- |
| 企业级 RAG 知识库 | 把企业文档变成可检索、可引用、可核验的问答系统 | 高，已有大量生产框架 | [IlyaRice/RAG-Challenge-2](https://github.com/IlyaRice/RAG-Challenge-2) | 中 |
| Hermes 多 Agent | 让多个具备独立上下文的 Agent 分工、并行、持久协作 | 中高，Hermes 已把调度做成产品 | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 中高 |
| AI 工业质检 | 用视觉/多模态模型做缺陷检测、定位、分类、报告 | 传统 AD 高，纯多模态大模型低 | [openvinotoolkit/anomalib](https://github.com/openvinotoolkit/anomalib) + [jam-cc/MMAD](https://github.com/jam-cc/MMAD) | 高（数据与现场集成是门槛） |

一句话选型：

- 想快速做出可用产品：优先 RAG，公开资料多、无需标注、可离线验证。
- 想做 Agent 基础设施或复杂任务自动化：研究 Hermes 的“会话内委派 + 持久看板”双层调度。
- 想做工业质检：不要把宝押在通用多模态大模型上，生产主线仍是专用异常检测模型，多模态模型做解释与报告。
- 想做本地 Hermes 应用：先从 Windows 原生 + 托管 llama.cpp 起步，单用户延迟最好；出现真实并发或 70B 需求，再把推理层迁到 WSL2/Linux 的 vLLM/SGLang（详见第五节）。

---

## 一、企业级 RAG 知识库（冠军方案）

### 1.1 它是什么

**Enterprise RAG Challenge（ERC）** 是由 Rinat Abdullin / TIMETOACT 等组织的 RAG 评测比赛，任务非常“企业真实”：

- 比赛当天给定 100 份随机公司的年度报告 PDF，单份最多约 1000 页；
- 2.5 小时内完成解析、建库；
- 再给定 100 道随机问题，要求尽快回答；
- 答案必须是明确类型：是/否、公司名、职位/产品名、数值指标等；
- **每个答案必须附带证据页码**，防止模型编造；
- 评分同时看正确率和引用是否正确。

冠军是 **Ilya Rice**，他同时拿下两个奖项提名，方案开源在 [IlyaRice/RAG-Challenge-2](https://github.com/IlyaRice/RAG-Challenge-2)（MIT）。官方赛题与评测代码在 [trustbit/enterprise-rag-challenge](https://github.com/trustbit/enterprise-rag-challenge)。

### 1.2 冠军方案的完整流水线

代码入口：`src/pipeline.py`；主要模块：

```
src/pdf_parsing.py            PDF -> JSON/Markdown
src/tables_serialization.py   表格序列化（实验性）
src/ingestion.py              建向量库
src/text_splitter.py          分块
src/retrieval.py              向量检索 + 父页面回溯
src/reranking.py              LLM 重排序
src/questions_processing.py   问题路由、答案生成、引用提取
src/prompts.py                全部提示词与结构化输出 schema
```

| 阶段 | 做法 | 关键参数 / 工具 |
| :--- | :--- | :--- |
| PDF 解析 | 基于 Docling 深度定制，保留标题、列表、表格结构；输出 Markdown + HTML 表格 | Docling，GPU（4090）加速；100 份约 40 分钟 |
| 文本清洗 | 一批正则清理解析噪声；对字体编码异常的文档整份走 OCR | 正则 + OCR |
| 表格处理 | 试验了“表格序列化”：把大表拆成主语 + 信息块的自然语言句子 | 最终**未启用**，因为会降低信噪比 |
| 分块 | 每页内切成小块，块记录所属页码；相邻块保留重叠 | 300 tokens / 50 overlap，递归切分 |
| 向量化 | 每份文档单独一个索引，避免跨公司污染 | `text-embedding-3-large` |
| 向量库 | 暴力精确检索，保证精度 | FAISS `IndexFlatIP`，一份文档一个库 |
| 召回 | 先取 top 30 chunks，再按页码去重映射回整页 | 小块负责“找得准”，整页负责“答得全” |
| 重排序 | 用 LLM 给页面打 0~1 相关性分；每次请求评 3 页 | GPT-4o-mini；最终分数 = 0.3 × 向量分 + 0.7 × LLM 分 |
| 上下文 | 取重排后的 top 10 页，每页前加页码，拼成上下文 | 页码用于最终引用 |
| 路由 1 | 从问题中用正则匹配公司名，路由到对应公司的向量库 | 搜索空间缩小 100 倍 |
| 路由 2 | 按期望答案类型选择不同提示词 | 数值 / 名称 / 名称列表 / 布尔 四套 prompt |
| 路由 3 | 多公司比较题先拆成每家公司一个子问题，并行回答后再汇总 | 例如 “Apple 和 Microsoft 谁营收高” |
| 生成 | 结构化输出 + 思维链 + one-shot 示例 | 默认 `gpt-4o-mini`；最佳配置 `o3-mini`；也验证了 Llama 70B |
| 输出字段 | `step_by_step_analysis`、`reasoning_summary`、`relevant_pages`、`final_answer` | 答案类型由 schema 约束，如 `Union[float, int, Literal['N/A']]` |
| 引用 | 从 `relevant_pages` 提取页码，映射回 PDF 的 SHA1 | 每条答案带 `pdf_sha1 + page_index` |
| 兜底 | 结构化输出校验失败时，把响应回传给 LLM 要求重排格式 | “SO Reparser”，把 8B 模型的合规率拉回 100% |
| 性能 | 按 25 题一批并发处理 | 100 题约 2 分钟完成 |

### 1.3 这套方案为什么赢

1. **解析质量决定上限**：作者试了约二十种 PDF 解析器，结论是没有一个能全自动完美解析，必须针对比赛文档做定制；解析错了，后面检索和提示词都救不回来。
2. **检索用小 chunks，生成用父页面**：小块提高相似度命中率，父页面补全上下文。这是“精度”和“完整性”的折中。
3. **LLM 重排序是性价比最高的一步**：向量召回只负责粗筛，LLM 对 3 页一组打分，成本低于 1 美分/题，但显著提升相关性。
4. **按文档/答案类型路由**：不要让一个 prompt 处理所有问题。每减少一条规则，模型就少犯一个错。
5. **结构化 CoT + 反幻觉指令**：强制模型分析“问题要的指标”和“上下文给的指标”是否真的匹配；不匹配就输出 `N/A`。
6. **表格序列化不是银弹**：作者原本很看好，但实测略降效果。Docling 的表格解析 + 检索 + LLM 理解已经够用，额外文本反而稀释信号。
7. **验证集驱动**：比赛前用公开的题目生成器造了 100 题验证集，逐项开关配置（是否重排、是否父页面、是否混合检索）看真实收益。
8. **小模型也能赢**：Llama 8B 也超过了 80% 的参赛者，说明系统设计比模型规模更重要。

### 1.4 GitHub 项目清单

| 项目 | 定位 | 用途 |
| :--- | :--- | :--- |
| [IlyaRice/RAG-Challenge-2](https://github.com/IlyaRice/RAG-Challenge-2) | 冠军方案源码 | 学习完整 RAG 流水线、路由、重排、引用 |
| [trustbit/enterprise-rag-challenge](https://github.com/trustbit/enterprise-rag-challenge) | 官方赛题/评测 | 复现评测、拿数据集、看评分标准 |
| [docling-project/docling](https://github.com/docling-project/docling) | 文档解析 | PDF/Office 转结构化 Markdown，支持表格与版面 |
| [infiniflow/ragflow](https://github.com/infiniflow/ragflow) | 生产级 RAG 引擎 | 想直接做企业知识库产品时优先看 |
| [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | 轻量 Graph RAG | 实体关系密集的知识库 |
| [microsoft/graphrag](https://github.com/microsoft/graphrag) | 图谱增强 RAG | 需要跨文档关系推理 |
| [deepset-ai/haystack](https://github.com/deepset-ai/haystack) | RAG 编排框架 | 自定义 pipeline、评测、部署 |
| [amazon-science/patchcore-inspection](https://github.com/amazon-science/patchcore-inspection) | 异常检测（与 RAG 无关） | 工业质检方向参考 |

### 1.5 如果要自己实现一套企业级 RAG

最小可行路线：

1. **解析层**：Docling / Unstructured / 自研版面解析；统一输出带页码、标题层级、表格的 JSON。
2. **索引层**：Elasticsearch/OpenSearch（BM25）+ 向量库（pgvector/Qdrant/Milvus/FAISS）；每条 chunk 带 `tenant_id / doc_id / page / section / ACL` 元数据。
3. **检索层**：查询改写 → 混合检索（BM25 + 向量）→ 元数据/权限过滤 → LLM 或 cross-encoder 重排 → 父文档扩展。
4. **生成层**：按问题类型路由 prompt；结构化输出；强制引用；无证据输出“不知道/未找到”。
5. **评测层**：构造 100~300 条黄金问答；分别评检索命中率、答案正确率、引用正确率、拒答率。
6. **运营层**：增量索引、文档版本、权限同步、查询日志、bad case 回流。

企业化时需要额外补的，不是冠军方案里的内容：

- 多租户与文档级 ACL；
- 增量更新与删除；
- 混合检索与查询改写；
- 表格/图表/扫描件的专门处理；
- 引用可点击回溯到原文位置；
- 成本与延迟预算；
- 评测集与回归测试。

---

## 二、Hermes 多 Agent 协作与调度

### 2.1 它是什么

**Hermes Agent** 是 Nous Research 开源的“自改进”AI Agent 框架（MIT），仓库：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)。

核心定位：

- 可跑在 5 美元 VPS、GPU 集群或无服务器环境；
- 支持 CLI、Telegram、Discord、Slack、WhatsApp、Signal、Email；
- 内置学习循环：从任务中创建/改进 skill、维护记忆、检索历史会话；
- 内置 cron 定时任务；
- 支持子 Agent 并行、Mixture of Agents、Kanban 持久任务板；
- 可接任意模型/provider，支持 MCP、ACP、40+ 工具。

“多 Agent 协作与调度”指的不是一个单独产品，而是 Hermes 运行时里的多层机制。中文架构笔记在 [cclank/Hermes-Wiki](https://github.com/cclank/Hermes-Wiki)，基于 Hermes 搭建多 Agent Web 系统的示例在 [linke-ai/hermes-agent-team](https://github.com/linke-ai/hermes-agent-team)。

### 2.2 五种运行时协作机制

| 机制 | 触发方式 | 作用域 | 调度方式 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **Delegate Task** | LLM 自主调用工具 | 单 session | `ThreadPoolExecutor`，最多 3 路并行，子 Agent 上下文隔离 | 同一任务拆成多个独立子任务并行做 |
| **Mixture of Agents** | LLM 自主调用工具 | 单 session | `asyncio.gather` 并发调 4 个参考模型，再由 1 个聚合模型汇总 | 高难度推理、需要多模型投票/互补 |
| **Background Review** | 系统计数器自动触发 | 单 session | 守护线程 fork 一个静默 Agent，非阻塞 | 定期提炼记忆、创建/改进 skill |
| **send_message** | LLM 调用工具 | 跨 Profile | 通过消息平台（Discord/Slack 等）转发 | 多个独立 bot 间接通信 |
| **Kanban** | dispatcher 每 60 秒 tick | 跨 session / 重启 / Profile | SQLite 任务板 + 独立 worker 子进程 | 长跑任务、多人/多 Agent 持久协作 |

补充机制：

- **`/goal` Ralph Loop**：持续目标模式，每轮结束由辅助模型判官判断是否完成，未完成自动续转，直到完成/预算耗尽/暂停。
- **`/handoff` / `/steer` / `/queue`**：会话迁移、对运行中 Agent 注入纠偏指令、后续指令排队。
- **IterationBudget**：父 Agent 默认 90 次迭代，每个子 Agent 独立 50 次；70% 预警、90% 强制收尾；子 Agent 不消耗父预算。

### 2.3 调度是怎么实现的

#### 会话内：Delegate Task

- 父 Agent 看到一个工具描述：“启动子 Agent 在隔离上下文中工作，只返回最终摘要”。
- 模型自己决定是否调用；框架在 `_invoke_tool()` 里做特殊分支，注入 `parent_agent`。
- 子 Agent 继承：模型、provider、API key、工作目录、凭证池、session DB 引用。
- 子 Agent 不继承：对话历史、终端 session、中间工具调用、推理过程、上下文文件、记忆。
- 工具集计算：`子 Agent 工具 = (用户指定 ∩ 父级可用) - 黑名单`，禁止递归委派、禁止向用户提问、禁止写共享记忆、禁止跨平台发消息。
- 默认最大深度 2（父 → 子 → 孙会被拒绝），可通过配置解锁 orchestrator 角色。
- 结果只返回结构化摘要：状态、摘要、API 调用数、耗时、模型、token 用量、工具轨迹。
- 中断会从父 Agent 传播到所有活跃子 Agent，已产出的部分结果保留。

#### 跨进程：Kanban

Kanban 是 Hermes 真正的“持久多 Agent 调度层”：

1. 任务写入 SQLite（`kanban.db`）。
2. dispatcher 每 60 秒 tick：
   - reclaim 过期 claim；
   - 把 `ready` 任务派发出去；
   - spawn 独立的 `hermes_cli.main` worker 子进程。
3. worker 通过 9 个 `kanban_*` 工具把状态写回 DB：claim → working → complete/block。
4. 可靠性机制：
   - heartbeat + TTL，claim 过期自动回收；
   - zombie worker 检测；
   - 异常退出自动 block；
   - 每个任务可配 `max_retries`；
   - 任务所有权校验，防止 worker 操作不属于自己的任务；
   - hallucination gate：worker 说“做完了”但数据库没有证据，拒绝完成。
5. 自动分解：triage 任务会被自动拆成 workgraph，根据子任务描述路由到不同的 specialist profile；所有子任务完成后根任务才 ready。
6. Profile 发现：编排器不硬编码专家名单，而是读取配置的 profile roster 动态决定可用专家。

这套设计的本质是：**把 Agent 协作变成任务板上的状态机**。Agent 不再是“一次性对话”，而是可以 claim 任务、心跳、失败重试、重启后继续的 worker。

### 2.4 自己实现多 Agent 调度时，抄什么

最小骨架：

```
Profile Registry        # 每个 Agent 的角色、模型、工具集、记忆、沙箱
Task Board (SQLite)     # task / status / owner / deps / retries / heartbeat
Dispatcher Loop         # 定时扫描 ready + 过期 claim，spawn worker
Worker Contract         # claim -> working -> complete/block，必须写证据
Budget Manager          # 父/子独立迭代预算，超限收尾
Observability           # 任务时间线、工具轨迹、token/成本、失败原因
```

关键设计决策：

| 决策 | 建议 |
| :--- | :--- |
| 会话内 vs 跨进程 | 单回合能完成、最多 3 个子任务 → 会话内委派；长跑、需重启恢复 → 持久任务板 |
| 子 Agent 上下文 | 默认隔离，只回传结构化摘要；需要共享时显式传文件/状态 |
| 工具权限 | 子 Agent 永远不能获得比父级更多的工具 |
| 递归委派 | 默认禁止，确需嵌套时限制深度 |
| 失败处理 | 心跳 + TTL + 重试上限 + 人工接管；不要静默重跑 |
| 成本控制 | 子 Agent 可配更便宜的模型；MoA 只用于高价值问题 |
| 验证 | “完成”必须有可核验的产物，不接受模型自述 |

Hermes 的代码级细节可看：

- `tools/delegate_tool.py` — 子 Agent 委派
- `tools/mixture_of_agents_tool.py` — 多模型协同
- `run_agent.py` — Background Review、IterationBudget、中断传播
- `hermes_cli/kanban_db.py` — 看板存储、任务分解、worker spawn
- `hermes_cli/kanban_diagnostics.py` — 卡住任务检测与诊断规则

### 2.5 GitHub 项目清单

| 项目 | 定位 | 用途 |
| :--- | :--- | :--- |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 主仓库 | 直接部署、读实现、扩展工具 |
| [cclank/Hermes-Wiki](https://github.com/cclank/Hermes-Wiki) | 中文架构笔记 | 快速理解五种协作机制与 Kanban 调度 |
| [jwangkun/hermes-agent-guide](https://github.com/jwangkun/hermes-agent-guide) | 中文指南 | 入门与配置 |
| [linke-ai/hermes-agent-team](https://github.com/linke-ai/hermes-agent-team) | 基于 Hermes Profile 的多 Agent Web 系统 | 参考多角色协作的产品化形态 |

---

## 三、AI 工业质检（多模态对决）

### 3.1 它是什么

工业质检的核心任务：

- 缺陷检测：有没有缺陷；
- 缺陷定位：在哪里（像素级/框级）；
- 缺陷分类：是什么类型；
- 缺陷描述与报告：为什么产生、怎么处理；
- 有时还包括尺寸测量、装配完整性检查。

“多模态对决”在公开资料里没有一个完全同名的固定赛事，最接近且最有代表性的是 **MMAD 基准**：把 GPT-4o、Gemini、LLaVA、Qwen-VL、InternVL 等通用多模态大模型放到工业异常检测任务上正面对决。它回答的问题正是：“通用多模态大模型能不能当工业质检员？”

MMAD（ICLR 2025，[jam-cc/MMAD](https://github.com/jam-cc/MMAD)）：

- 8,366 张工业图像，38 个产品类别，来自 4 个公开数据集；
- 39,672 道多选题，覆盖 7 个子任务；
- 最好的是 GPT-4o，平均准确率 **74.9%**；
- 人类专家平均 **86.7%**；
- 主要短板：领域知识不足、细粒度感知弱、多图比较能力差；
- 结论：通用多模态大模型有潜力，但离工业级可靠性还有明显距离。

另一条“对决”是**传统专用异常检测 vs 多模态大模型**：

- 传统方法（PatchCore、EfficientAD 等）在固定品类、固定工位上精度高、延迟低，但需要正常样本建模，换型成本高；
- 多模态大模型零样本/少样本、能说人话、能生成报告，但对微小缺陷、反光、遮挡、尺寸测量不稳定，延迟和成本也更高。

### 3.2 三条实现路线

| 路线 | 代表项目 | 训练数据 | 优点 | 缺点 | 适合 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 传统无监督异常检测 | [Anomalib](https://github.com/openvinotoolkit/anomalib)、[PatchCore](https://github.com/amazon-science/patchcore-inspection) | 只需正常样本 | 精度高、延迟低、可边缘部署、可解释到像素 | 每个品类/工位单独建模，换型要重新采集 | 产线在线检测主链路 |
| 零样本/少样本 VLM | [AnomalyCLIP](https://github.com/zqhang/AnomalyCLIP)、[AnomalyGPT](https://github.com/CASIA-IVA-Lab/AnomalyGPT)、[Myriad](https://github.com/tzjtatata/Myriad) | 少量正常样本 + 文本 | 换型快、能定位、能对话 | 细粒度精度不足，推理成本高 | 新品试产、开放词汇缺陷、辅助复核 |
| 领域微调多模态模型 | [Defect-GLM](https://github.com/WH-HuanWang/Defect-GLM) | 领域图像 + 人工/LLM 生成问答 | 领域术语准、能出报告 | 需要标注与训练资源，泛化到新品类弱 | 单一大品类（如晶圆、PCB）深度落地 |

补充：

- **Anomalib** 是目前最完整的开源异常检测库：PatchCore、EfficientAD、PaDiM、FastFlow、STFPM、Reverse Distillation、WinCLIP 等；基于 PyTorch Lightning；支持 OpenVINO 导出；带 Anomalib Studio 低代码界面，可接 USB/IP 相机，通过 ROS/MQTT 对接产线。
- **AnomalyGPT** 是较早的 LVLM 工业异常检测方案：ImageBind 视觉编码 + Vicuna LLM + PandaGPT 初始化，无需人工阈值，能输出异常存在性、位置和描述。
- **Myriad** 把 RGB、3D 点云和文本结合，用视觉专家模型提取特征，再对齐到多模态大模型，适合有三维数据的场景。
- **Defect-GLM** 基于 VisualGLM-6B + LoRA 微调半导体晶圆缺陷数据，报告准确率 96%，是“领域微调”的典型样例。

### 3.3 推荐落地方案：快慢双通道

生产环境不要用一个大模型包打天下，建议双通道：

```
产线相机 / 3D 相机
        │
        ▼
快速检测通道（边缘/本地）
  - PatchCore / EfficientAD / YOLO
  - 输出：OK/NG、缺陷框、缺陷掩码、置信度
        │
        ├── OK → 直接放行
        │
        └── NG / 低置信
                │
                ▼
        多模态复核通道（本地 GPU / 云端）
          - Qwen2.5-VL / InternVL / AnomalyGPT
          - 输入：原图 + 缺陷裁剪 + 工位/品类知识
          - 输出：缺陷类型、严重程度、自然语言描述
                │
                ▼
        RAG 知识库（可选）
          - 缺陷案例、工艺参数、维修手册
          - 输出：可能原因、处置建议、相似历史案例
                │
                ▼
        人工复核 / MES 工单
```

为什么这样分工：

- 检测链路要求毫秒级、稳定、可复现，专用模型更合适；
- 多模态模型擅长语义解释、开放词汇、报告生成，但不适合承担高风险的像素级判定；
- RAG 把“检测结果”变成“可执行的处置知识”，这是企业真正愿意付费的部分。

### 3.4 评测与数据

公开数据集：

| 数据集 | 规模/特点 | 用途 |
| :--- | :--- | :--- |
| MVTec AD | 15 类，5,354 张，像素级标注 | 异常检测入门基准 |
| VisA | 12 类，10,821 张 | 多品类泛化 |
| Real-IAD | 30 类，15 万张，5 个视角 | 更接近真实产线 |
| MMAD | 8,366 图 / 39,672 题，7 子任务 | 多模态大模型工业质检评测 |
| MVTec 3D-AD / Real-IAD D³ | RGB + 3D/伪 3D | 三维缺陷检测 |

关键指标：

- 图像级 AUROC / F1；
- 像素级 AUROC / PRO；
- 误检率（产线最在意）、漏检率；
- 单张延迟、吞吐、模型体积；
- 换型时间、标注成本；
- 多模态模型额外看：描述准确率、幻觉率、报告可用性。

### 3.5 GitHub 项目清单

| 项目 | 定位 | 用途 |
| :--- | :--- | :--- |
| [openvinotoolkit/anomalib](https://github.com/openvinotoolkit/anomalib) | 异常检测算法库 | 生产主链路首选，算法全、可导出 OpenVINO |
| [amazon-science/patchcore-inspection](https://github.com/amazon-science/patchcore-inspection) | PatchCore 官方实现 | 理解无监督异常检测的代表作 |
| [zqhang/AnomalyCLIP](https://github.com/zqhang/AnomalyCLIP) | 零样本异常检测 | 开放词汇缺陷、快速换型 |
| [CASIA-IVA-Lab/AnomalyGPT](https://github.com/CASIA-IVA-Lab/AnomalyGPT) | LVLM 工业异常检测 | 多模态复核通道参考 |
| [tzjtatata/Myriad](https://github.com/tzjtatata/Myriad) | RGB+3D+文本多模态 | 有三维数据的场景 |
| [WH-HuanWang/Defect-GLM](https://github.com/WH-HuanWang/Defect-GLM) | 领域微调范例（晶圆） | 单品类深度落地参考 |
| [jam-cc/MMAD](https://github.com/jam-cc/MMAD) | 多模态工业质检基准 | 选型评测、论文复现 |
| [Tencent/AnomalyDetection_Real-IAD](https://github.com/Tencent/AnomalyDetection_Real-IAD) | Real-IAD 官方实验代码 | 真实多视角数据集训练 |
| [M-3LAB/awesome-industrial-anomaly-detection](https://github.com/M-3LAB/awesome-industrial-anomaly-detection) | 论文/项目清单 | 持续跟踪 SOTA |

---

## 四、三个方向怎么组合

### 组合 1：企业知识库 Agent（RAG + Hermes）

- Hermes 做编排：检索 Agent、核验 Agent、报告 Agent、人工审批；
- RAG 做证据层：每个结论必须带文档页码；
- 适合：企业制度问答、合同审查、运维知识库、投研报告。

### 组合 2：工业质检 + 知识库（CV + VLM + RAG）

- 专用模型负责“发现缺陷”；
- 多模态模型负责“解释缺陷”；
- RAG 负责“给出处置建议、关联历史案例、生成工单”；
- 适合：制造企业质检、设备运维、售后诊断。

### 组合 3：Agent 基础设施（Hermes 模式）

- 把任务板、worker、心跳、重试、预算、证据校验做成平台；
- 上层接 RAG、代码、数据分析等不同能力；
- 适合：想做“AI 员工/数字同事”产品的团队。

---

## 五、本地 Hermes Agent 应用的技术架构（性能优先）

> 目标：本地优先、数据不出机器，在可接受延迟内把单机 Agent 跑顺。
> “性能”要拆成四个指标看：首 token 延迟（TTFT）、生成速度（tok/s）、单任务完成时间、并发吞吐。四者的优化手段不同，不能只看模型跑分。

### 5.1 架构原则：推理面与 Agent 面分离

本地 Agent 卡顿，通常不是 Agent 框架慢，而是**模型服务被反复加载、上下文过长、并发抢显存**。先定五条原则：

1. **一个模型服务，多个 Agent 共享。** 主 Agent、子 Agent、压缩、路由都走同一个 OpenAI 兼容端点；不要给每个子 Agent 起一个模型进程。
2. **Agent 面只做编排。** Hermes 的 loop、工具、技能、SQLite 不占 GPU；性能预算几乎全在推理和上下文。
3. **上下文是最大成本。** 本地 prefill 与 KV cache 都按 token 计费（显存和时间），能用检索解决就不要堆长上下文。
4. **并发靠队列，不靠多开模型。** 单卡用 Kanban/任务队列排队；多开只会互相换出显存。
5. **本地优先 ≠ 全部本地。** 难的推理可保留可选云端升级通道，但默认路径、密钥和数据落盘都在本地。

```text
┌─────────────────────────────────────────────┐
│ UI：桌面窗口 / 本地 Web / CLI / 消息网关      │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│ Hermes Agent 运行时                          │
│ 会话循环 · 工具调用 · 技能 · 子 Agent · 压缩  │
└───────┬──────────────────────────┬──────────┘
        │                          │
┌───────▼─────────┐      ┌─────────▼─────────┐
│ SQLite 状态      │      │ 工具沙箱           │
│ WAL + FTS5      │      │ WSL2 / Docker      │
└─────────────────┘      └───────────────────┘
        │
┌───────▼─────────────────────────────────────┐
│ 唯一本地推理服务（OpenAI 兼容）              │
│ llama.cpp / vLLM / SGLang                   │
│ 主模型 + 小模型（压缩/路由/嵌入/重排）        │
└─────────────────────────────────────────────┘
```

### 5.2 三套参考架构

| 维度 | A. 桌面单机 | B. 开发工作站 | C. 团队/本地服务器 |
| :--- | :--- | :--- | :--- |
| 系统 | Windows 原生 | Windows + WSL2 | Linux |
| 推理 | Hermes 托管 llama.cpp | WSL2 内 vLLM / SGLang | Linux vLLM / SGLang，多卡张量并行 |
| 用户/并发 | 1 人，1–2 并发 | 1–3 人，2–4 并发 | 5–50 人，8–32 并发 |
| 模型 | 4B–32B GGUF | 14B–70B AWQ/GPTQ/FP8 | 32B–235B |
| 优点 | 零运维、安装即用、单请求最快 | 高并发吞吐可达数倍 | 可隔离、可配额、可扩容 |
| 代价 | 无 vLLM 级高并发批处理；Windows 沙箱弱 | WSL2 运维、显存直通、驱动排障 | 运维成本高，需要 API 网关和鉴权 |
| 适用 | 个人助理、知识库、本地自动化 | 小团队、开发测试、多子 Agent | 公司内部“AI 员工”平台 |

**A 是默认起点。** Hermes 已经自带 Windows 的 CUDA/Vulkan/CPU 后端、模型目录、量化选择、显存放置、空闲卸载和 64K 上下文保障，直接用它比自研推理管理省几个月。单用户场景下 llama.cpp 的单请求速度也最好。

**B 只在两种情况下值得上：** 需要 2 个以上请求真正并行（例如多个子 Agent 同时跑），或者需要 70B 级模型而单卡放不下。同一个模型单请求约 38 tok/s 时，vLLM 在 10 并发下的总吞吐可到 250+ tok/s，但单请求反而略慢。

**C 的关键不是模型，是调度和隔离。** 多用户时要有请求队列、每用户预算、会话隔离、模型版本管理；Hermes 的 Kanban + worker 子进程可以作为调度层，推理层独立扩容。

### 5.3 组件选型

| 层 | 默认选择 | 升级选择 | 说明 |
| :--- | :--- | :--- | :--- |
| Agent 运行时 | Hermes Agent | 自研 loop + Hermes 模式 | 直接复用 `AIAgent`、工具注册、压缩、子 Agent、Kanban |
| 推理引擎 | llama.cpp（Hermes 托管） | vLLM / SGLang（WSL2/Linux） | 单请求 vs 并发吞吐的分水岭 |
| 主模型 | Qwen3.5 / Qwen3 / GLM / Gemma，按显存选 | 70B 级或 MoE | 优先看工具调用成功率，不只看通用跑分 |
| 上下文管理 | Hermes 压缩器，50% 触发，lean tail | 自研分层摘要 | 本地压缩要用小模型，别用主模型硬扛 |
| 会话存储 | SQLite WAL + FTS5 | PostgreSQL（多用户） | 单机不要上重型数据库 |
| 本地 RAG | SQLite FTS5 + sqlite-vec | Qdrant / Milvus | 10 万 chunk 以内 sqlite-vec 足够 |
| 嵌入 | bge-m3 / Qwen3-Embedding-0.6B | 更大嵌入模型 | 小语料 CPU 也能跑，批量嵌入 |
| 重排 | bge-reranker-v2-m3 交叉编码器 | LLM 重排（仅高价值查询） | 本地逐 query 做 LLM 重排太贵 |
| 沙箱 | WSL2 / Docker | 独立低权限容器 | Windows 原生工具执行要做路径/命令白名单 |
| 可观测 | 结构化日志 + SQLite 指标表 | OpenTelemetry + Prometheus | 至少记录 TTFT、tok/s、上下文、显存 |
| UI | 本地 Web（React/Electron） | 桌面原生壳 | 复用 Hermes 的 CLI/网关能力 |

### 5.4 模型与显存档位

先记住两个公式，选型不会拍脑袋：

**权重显存**：4-bit 量化约 `0.6 GB / 1B 参数`（Q4_K_M，含少量开销）。8B≈5GB，14B≈9GB，32B≈20GB，70B≈40GB。

**KV cache**：`2 × 层数 × KV heads × head_dim × 字节数 × token 数`。以 GQA（8 KV heads × 128 head_dim）为例：

| 模型级别 | FP16 KV/token | 32K 上下文 | 64K 上下文 | q8 KV 后 64K |
| :--- | ---: | ---: | ---: | ---: |
| 8B（36 层） | 144 KiB | 4.5 GiB | 9 GiB | 4.5 GiB |
| 14B（40 层） | 160 KiB | 5 GiB | 10 GiB | 5 GiB |
| 32B（64 层） | 256 KiB | 8 GiB | 16 GiB | 8 GiB |
| 70B（80 层） | 320 KiB | 10 GiB | 20 GiB | 10 GiB |

> 具体值以模型 `config.json` 为准；q8 KV 基本无损，q4 KV 更省但会掉质量。很多人以为 24GB 能跑“32B + 64K”，实际权重 20GB + FP16 KV 16GB 已经 36GB，必须降上下文、量化 KV 或换小模型。

| 显存 | 推荐模型 | 量化 | 上下文 | KV | 预期解码（估算） | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 8GB | Qwen3.5-4B / Qwen3-8B | Q4 | 4B 可 64K；8B 16–24K | q8 | 25–45 tok/s | 8B 上 64K 会挤爆，优先保上下文 |
| 12GB | Qwen3-8B / Qwen3.5-8B | Q4/Q5 | 64K | q8 | 35–52 tok/s | RTX 3060 12GB 实测 8B Q4 约 52 tok/s |
| 16GB | Qwen3-14B；Gemma 4 27B（会溢到内存） | Q4 | 64K | q8 | 25–45 tok/s | 14B 全显存更稳；27B 属于“能跑” |
| 24GB | Qwen3-14B Q8 / Qwen3-32B Q4 | Q4/Q8 | 14B 可 64K；32B 建议 16–24K | q8 | 25–40 tok/s | 32B + 64K 需 spill 或 q4 KV |
| 48GB | Qwen3-32B Q8 / Llama 3.3 70B Q4 | Q4/Q8 | 32B 64K；70B 32K | q8 | 25–38 tok/s | 双卡或单卡 48GB |
| 64GB | Llama 3.3 70B Q4 | Q4 | 64K | q8 | 20–38 tok/s | 70B Q4 约 40GB + 10GB KV |
| 96GB+ | 70B Q8 / 更大 MoE | Q8/Q4 | 64K+ | q8 | 15–30 tok/s | 大 MoE 看总显存，解码看激活参数 |

> 解码速度是带宽受限的估算，实际受 batch、KV 类型、是否 spill、驱动影响。第三方 2026-04 实测（RTX 4090，Llama 3.3 70B Q4，VRAM 39GB 配置）llama.cpp 38 tok/s、Ollama 36、vLLM 单请求 34；vLLM 10 并发 250+ tok/s。该测试的 39GB 显存意味着多卡或部分卸载，不能直接套到单张 24GB 卡上。

> Hermes 官方口径：8GB+ 可舒服跑小模型，16GB+ 可跑 27–35B 高质量档（允许部分放系统内存）。托管模式会为推荐模型保底 64K，放不下时按“专家权重优先、注意力缓存不动”的顺序溢到内存；如果自建 llama-server，可以按上表主动降到 16–32K 换速度。

**选模型的顺序**：先定上下文（Agent 至少 32K，推荐 64K）→ 算 KV → 剩下的显存给权重 → 选能全显存放下的最大模型。放不下就降一档模型或量化 KV，不要盲目 spill，spill 会让解码速度掉一个数量级。

Agent 场景还要看工具调用成功率。下面是 2026 年第三方博客汇总的候选排序（非独立复现，评测集不同，不能横比）：

| 模型 | 4-bit 约显存 | 工具调用成功率 | 备注 |
| :--- | ---: | ---: | :--- |
| Gemma 4 27B | 16GB | ~95% | 16GB 档热门 |
| GLM-4.7 32B | 20GB | ~94% | 中文场景可优先测 |
| Qwen3 32B | 20GB | ~93% | 生态成熟 |
| Qwen3-Coder 30B | 18GB | ~96% | 代码/工具链强 |
| Llama 3.3 70B | 42GB | ~97% | 需要 48GB+ |

> 工具调用失败一次，用户感知到的延迟可能是几十秒；上线前务必用你自己的 20–30 个任务复测，不要直接采信跑分。Qwen3.5 系列覆盖 0.8B–397B、原生 256K 上下文；llama.cpp 支持情况以发布时文档为准，Ollama 兼容性需自行验证。

### 5.5 Hermes 的性能配置

**A. Windows 桌面（llama.cpp）**

```yaml
local_runtime:
  enabled: true
  backend: auto          # NVIDIA→CUDA，AMD/Intel→Vulkan，无 GPU→CPU
  detect_ports: [8081]

providers:
  llamacpp:
    base_url: http://127.0.0.1:8081/v1
    model: qwen3-14b-q4

model:
  provider: llamacpp
  default: qwen3-14b-q4

compression:
  threshold: 0.50        # 到上下文 50% 触发压缩
  target_ratio: 0.20
  tail_mode: lean        # 保留 2.5% 上下文（10K 下限/25K 上限）
  protect_last_n: 20
  min_tail_user_messages: 1
```

要点：
- 托管运行时会按显存选量化、按需增长上下文、空闲 15 分钟卸载；交互式应用可把空闲卸载关掉或调长，避免每次都冷启动。
- 不要开 `micro_compact`。它默认关闭，每轮压缩一次、会打断前缀缓存，本地还要多一次模型调用。
- 压缩用独立的小模型（4B–8B）比主模型快得多；Hermes 的 auxiliary 槽位要全部指向本地端点，避免隐私数据意外走云。
- Hermes 的 `system_and_3` prompt caching 只对支持 `cache_control` 的 Anthropic 路由有效（原生 Anthropic 或 OpenRouter）；本地 llama.cpp/vLLM 的缓存是引擎侧前缀缓存，配置项不同，但“前缀稳定”的纪律一样。

**B. WSL2 + vLLM（工作站）**

```bash
# WSL2 内，CUDA 驱动由 Windows 提供；模型名按实际下载的 AWQ 权重替换
vllm serve Qwen/Qwen3-32B-AWQ \
  --served-model-name qwen3-32b \
  --quantization awq \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 4 \
  --enable-prefix-caching   # 新版本 V1 可能默认开启，以官方文档为准
```

- 截至目前 vLLM 官方不支持 Windows 原生，只能走 WSL2 或 Docker；SGLang 类似。
- `max-num-seqs` 按显存和 SLA 调，别照搬 32；每个并发序列都要 KV。
- 前缀缓存对 Agent 多轮极其关键：系统提示、技能、历史必须保持**前缀稳定**，时间戳、随机 ID、动态工具列表放消息尾部。
- Hermes 侧注册一个 OpenAI 兼容 provider，`base_url` 指到 `http://127.0.0.1:8000/v1`，主模型和 auxiliary 都走它。

### 5.6 十个性能杠杆（按收益排序）

| 杠杆 | 做法 | 收益 | 注意 |
| :--- | :--- | :--- | :--- |
| 1. 共享推理服务 | 所有 Agent 共用一个端点，队列排队 | 避免重复加载和显存抖动 | 子 Agent 并发要限流 |
| 2. 稳定前缀 | 系统提示/技能/历史只追加，不重排 | 前缀缓存命中，TTFT 降 13–31%（长上下文更多） | 动态内容放尾部 |
| 3. 上下文预算 | 50% 触发压缩，lean tail | 避免 prefill 线性变慢 | 压缩本身要算成本 |
| 4. 小模型做辅助 | 压缩/路由/标题用 4B–8B | 辅助调用快 2–5 倍 | 质量敏感任务仍用主模型 |
| 5. 限制子 Agent 并发 | 单卡 2–3 个，按显存算 | 防止 KV 挤爆和换页 | 多卡再放大 |
| 6. 工具输出截断 | 大文件用 grep/head，网页存盘再检索 | 直接省 token | 别把整篇文档塞进上下文 |
| 7. 流式输出 | 最终回答流式，工具调用不流式 | 感知延迟降低 | 解析工具参数要完整 |
| 8. 不中途切模型 | 固定主模型；难任务走独立端点 | 避免缓存失效和重载 | 需要多模型就多端点 |
| 9. 批量/错峰 | cron、索引、离线评测放空闲时段 | 不抢交互请求 | 需要队列和优先级 |
| 10. 量化 KV | llama.cpp q8_0 KV；vLLM FP8 KV | 上下文显存减半 | q4 KV 有质量损失 |

补充：
- **投机解码**（draft model / n-gram）在代码补全、格式化输出上常有 1.5–2 倍加速，但要多占显存，且对开放式推理收益不稳定；先测再开。
- **MoE 模型**总显存大、激活参数小，解码快，适合本地；但专家权重放不下时会大量 spill，反而慢。
- **嵌入/重排**尽量批处理；小语料把嵌入放 CPU，把 GPU 留给主模型。
- **会话库**放本地 SSD，SQLite 开 WAL，单写者；不要放网络盘或同步盘。

### 5.7 本地 RAG 的性能设计

把第一节的冠军方案搬到本地，要做三处“降本”：

| 环节 | 冠军方案 | 本地改造 | 原因 |
| :--- | :--- | :--- | :--- |
| 解析 | Docling + OCR | 同左，离线批处理 | 解析是一次性成本 |
| 切块 | 300 token / 50 overlap | 同左，保留页码 | 页码是引用可核验的前提 |
| 检索 | 向量 + 公司路由 | SQLite FTS5 + sqlite-vec 混合检索 | 单机免服务，BM25 补语义 |
| 重排 | LLM 重排 3 页/请求 | 交叉编码器重排 20–30 → 6–10 | 本地 LLM 重排延迟太高 |
| 回答 | 结构化 CoT + 引用 | 同左，小模型加 one-shot | 结构化输出提升可解析性 |
| 缓存 | 无 | 查询嵌入/检索结果缓存 | 重复问题直接命中 |

延迟预算（单机 32B，估算）：

| 阶段 | 目标 |
| :--- | ---: |
| 查询嵌入 | 20–100 ms |
| FTS + 向量检索 | 5–50 ms |
| 交叉编码器重排 20 条 | 50–200 ms |
| LLM TTFT | 0.5–2 s |
| 生成 300–800 token | 10–30 s |
| 端到端 | 3–10 s（p50） |

如果 RAG 查询占比高，优先优化重排和 top-k，而不是换更大的生成模型。

### 5.8 评测：别只看 tok/s

固定一套 20–30 个任务的本地评测集，覆盖：

1. 单轮问答（无工具）
2. 5–10 轮工具调用（读文件、改文件、跑命令）
3. RAG 问答并给出页码引用
4. 长文档摘要（触发压缩）
5. 3 个子 Agent 并行
6. 冷启动（模型未加载）
7. 中途模型切换（如果产品支持）

每次记录：

| 指标 | 说明 | 建议起点 |
| :--- | :--- | :--- |
| TTFT p50/p95 | 首 token 延迟 | p50 < 2s，p95 < 5s |
| 解码速度 | tok/s | > 20 tok/s（Hermes 的本地推荐下限） |
| 单任务完成时间 | 端到端 | 简单工具任务 < 15s |
| 每轮 prompt token | 上下文规模 | 常见任务 < 16K |
| 前缀缓存命中率 | 多轮复用 | > 70% |
| 压缩次数/延迟 | 压缩开销 | 每次会话 < 3 次，压缩 < 5s |
| 显存峰值/余量 | 稳定性 | 余量 > 10% |
| 队列等待 | 并发体验 | p95 < 2s |
| 任务成功率 | 正确性 | > 90% |
| 崩溃/卡死率 | 稳定性 | < 1% |

> 这些是起点，不是承诺；先用你自己的任务跑基线，再决定是否换引擎/模型。

### 5.9 分阶段落地

| 阶段 | 时间 | 交付 | 验收 |
| :--- | :--- | :--- | :--- |
| P0 基线 | 0.5–1 天 | Hermes + 托管 llama.cpp + 10 个任务 | 能跑通，记录 TTFT/tok/s/显存 |
| P1 可用 | 3–5 天 | 稳定推理服务、会话库、流式 UI、日志 | 连续 2 小时不崩，p95 可接受 |
| P2 好用 | 1–2 周 | 工具/技能、RAG、沙箱、子 Agent | 20 任务评测 > 90% |
| P3 多 Agent | 1–2 周 | Kanban、cron、预算、审批、观测 | 3 个 worker 稳定，队列可控 |
| P4 扩容 | 按需 | WSL2 + vLLM/SGLang、多用户鉴权 | 并发 8+，TTFT 不劣化 |

**先做 A，不要一上来就 vLLM。** 单用户场景 llama.cpp 的单请求速度最好、依赖最少、Windows 原生可跑；等 P3 出现真实并发瓶颈，再迁 B/C。迁移时 Agent 层不动，只换 OpenAI 兼容端点。

### 5.10 常见反模式

- 每个子 Agent 起一个模型进程 → 显存 OOM、互相换页。
- 用 200K 上下文代替检索 → 每次 prefill 更慢，KV 直接爆。
- 本地每个 query 做 LLM 重排 → 延迟翻倍，收益远小于交叉编码器。
- 开启 micro-compaction → 每轮多一次调用，还打断前缀缓存。
- 中途切模型 → 缓存全失效，还要重新加载。
- 会话库放网络盘/同步盘 → SQLite 锁竞争甚至损坏。
- 工具输出不截断 → 一次 `cat` 大文件就把上下文打满。
- 只看 tok/s → 忽略了 TTFT、压缩、工具等待这些真正影响体验的部分。
- 用 CPU 跑 32B 做 Agent → 3–5 tok/s，工具循环基本不可用。
- 忽略 KV cache → 以为 24GB 能跑 32B + 64K，实际直接 spill。

### 5.11 一句话结论

**默认架构：Windows 原生 Hermes + 托管 llama.cpp + 一个共享的本地 OpenAI 兼容端点 + SQLite（会话/FTS5）+ 交叉编码器重排的本地 RAG。** 模型按“先保 64K 上下文、再选最大全显存模型”的原则选；单用户不要上 vLLM。出现真实并发或 70B 需求时，再把推理层换成 WSL2/Linux 上的 vLLM/SGLang，Agent 层保持不变。

---

## 六、参考来源

- Enterprise RAG Challenge 冠军复盘：[Ilya Rice: How I Won the Enterprise RAG Challenge](https://abdullin.com/ilya/how-to-build-best-rag/)
- 冠军源码：[IlyaRice/RAG-Challenge-2](https://github.com/IlyaRice/RAG-Challenge-2)
- 官方赛题：[trustbit/enterprise-rag-challenge](https://github.com/trustbit/enterprise-rag-challenge)
- Hermes Agent：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- Hermes 多 Agent 架构笔记：[cclank/Hermes-Wiki - multi-agent-architecture](https://github.com/cclank/Hermes-Wiki/blob/master/concepts/multi-agent-architecture.md)
- Hermes 中文指南：[jwangkun/hermes-agent-guide](https://github.com/jwangkun/hermes-agent-guide)
- MMAD 论文：[arXiv:2410.09453](https://arxiv.org/abs/2410.09453)
- MMAD 仓库：[jam-cc/MMAD](https://github.com/jam-cc/MMAD)
- MMAD 中文解读：[多模态大模型能否胜任工业异常检测？](https://cloud.tencent.com/developer/article/2496366)
- Real-IAD 论文：[arXiv:2403.12580](https://arxiv.org/abs/2403.12580)
- Real-IAD 仓库：[Tencent/AnomalyDetection_Real-IAD](https://github.com/Tencent/AnomalyDetection_Real-IAD)
- Anomalib：[openvinotoolkit/anomalib](https://github.com/openvinotoolkit/anomalib)
- AnomalyGPT：[CASIA-IVA-Lab/AnomalyGPT](https://github.com/CASIA-IVA-Lab/AnomalyGPT)
- Defect-GLM：[WH-HuanWang/Defect-GLM](https://github.com/WH-HuanWang/Defect-GLM)
- Myriad 论文：[Myriad: a large multimodal model applying vision experts for industrial anomaly detection](http://scis.scichina.com/en/2026/192103.pdf)
- Hermes 本地模型文档：[Local Models](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/local-models.md)
- Hermes 上下文压缩与缓存：[Context Compression & Prompt Caching](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/context-compression-and-caching.md)
- Hermes Agent 循环：[Agent Loop Internals](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md)
- Hermes 微压缩：[Micro-Compaction](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/micro-compaction.md)
- Hermes 子 Agent 委派：[Delegation](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/delegation.md)
- 推理引擎对比（第三方实测，2026-08-26）：PromptQuorum《llama.cpp vs Ollama vs vLLM 2026》
- vLLM 官方文档：[docs.vllm.ai](https://docs.vllm.ai/en/latest/)
- llama.cpp：[ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp)
- sqlite-vec：[asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)
- bge-m3 嵌入模型：[BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)
- bge-reranker-v2-m3：[BAAI/bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3)
- Qwen3-Embedding-0.6B：[Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
