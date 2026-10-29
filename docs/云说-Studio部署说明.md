# 云说 Studio 单机部署说明

本文覆盖 **M5-B 之后的主流程最后一环：Studio 单机部署**。目标是让一个全新主机用 Docker Compose 启动数据库、迁移、首个所有者、API、worker 与 Web，并通过一个对外的 Web 端口访问完整写作流程。

范围是**单机试点交付**，不是高可用生产平台。诚实边界见文末。

## 一、交付内容

| 组件 | 文件 | 说明 |
| --- | --- | --- |
| API/worker 镜像 | `deploy/api.Dockerfile` | 共用镜像，容器内用 `tsx` 运行 TypeScript；迁移与 bootstrap 复用该镜像 |
| Web 镜像 | `deploy/web.Dockerfile` | Vite 构建静态资源，nginx 提供页面并反代 `/api` |
| nginx | `deploy/nginx.conf` | SPA 回退、SSE 关闭缓冲、安全响应头、20MB 请求体上限（对应旧章导入） |
| 全栈编排 | `docker-compose.studio.yml` | db、migrate、bootstrap、api、worker、web；只有 web 暴露端口 |
| 环境模板 | `.env.studio.example` | 密钥、公开地址、首个所有者、邮件与 OIDC 配置 |
| 首次所有者 | `apps/api/src/bootstrap.ts` | 创建账号、工作区、owner 成员关系；幂等且不重置既有密码 |

关键行为：

- **迁移先于服务**：`migrate` 成功退出后 `api` 与 `worker` 才启动；迁移按文件名顺序执行并记录在 `schema_migrations`，重复执行是空操作。
- **bootstrap 在每次部署启动时执行一次，但只新建缺失账号**：API 还要等 bootstrap 成功退出后才启动；邮箱已是某工作区所有者时跳过；账号存在但不是所有者时只警告、不修改角色，也不重置密码。密码、称呼与工作区名称只在需要新建账号时校验。
- **数据库与 API 不对宿主机开放**：Compose 内只有 `web` 发布 `${STUDIO_HTTP_PORT}:80`，API 仅在 Docker 网络中可达。
- **健康检查**：API 通过 `GET /api/health`（含一次 `SELECT 1`）检查；Web 通过 `/healthz` 检查；`web` 等待 API healthy 后才启动。
- **SSE 路径**：nginx 对 `/api/` 关闭 `proxy_buffering` 与缓存，AI 提案流式事件不会被攒住。
- **反向代理重建**：nginx 使用 Docker 内置 DNS 重新解析 `api`，API 容器重建换 IP 后无需重启 web。

## 二、前置条件

- Docker Engine 24+，Docker Compose v2（`docker compose version` 可用）。
- 建议 ≥4 GB 可用内存、≥10 GB 磁盘；首次构建需要拉取 Node 24、nginx 1.27 与 pgvector/pg17 镜像。
- 主机可访问镜像仓库；要使用在线模型服务时，容器需能访问服务商端点。
- 端口默认 `8088`，可用 `STUDIO_HTTP_PORT` 修改。
- 本机已有 Ollama 时，容器内 API/worker 可用 `http://host.docker.internal:11434/v1` 配置嵌入服务商；Compose 已为 Linux 添加 `host-gateway` 映射。模型端点默认拒绝本机、内网与保留地址，这类地址需先设 `STUDIO_MODEL_ENDPOINT_ALLOW_PRIVATE=1` 放行（见下）。

## 三、配置

在仓库根目录：

```bash
cp .env.studio.example .env.studio
```

填写 `.env.studio`，至少需要：

| 变量 | 要求 |
| --- | --- |
| `STUDIO_HTTP_PORT` | 对外 Web 端口，默认 `8088` |
| `STUDIO_PUBLIC_ORIGIN` | 浏览器实际访问的完整 origin，如 `http://localhost:8088` 或 `https://yunshuo.example.com`；必须与 OIDC 回调一致 |
| `STUDIO_DB_PASSWORD` | 数据库密码，只允许 URL 安全字符（字母数字与 `- _ .`） |
| `STUDIO_SESSION_SECRET` | 会话签名密钥，随机长字符串 |
| `STUDIO_MODEL_KEY_SECRET` | 模型 API Key 加密主密钥，**必须独立于会话密钥** |
| `BOOTSTRAP_OWNER_EMAIL` | 首个所有者邮箱 |
| `BOOTSTRAP_OWNER_PASSWORD` | 首次创建所有者时至少 10 位；已有所有者后可留空，bootstrap 不再校验 |
| `BOOTSTRAP_OWNER_NAME` | 显示称呼，默认“所有者” |
| `BOOTSTRAP_WORKSPACE_NAME` | 新工作区名称，默认“云说工作区” |

密钥要求：API 与 worker 在 `NODE_ENV=production` 下都要求同时提供 `STUDIO_SESSION_SECRET` 与独立的 `STUDIO_MODEL_KEY_SECRET`，两者相同的配置会被拒绝启动；worker 必须与 API 使用同一个模型密钥才能解密服务商 API Key。bootstrap 与 migrate 不加载模型密钥。

生成两个随机密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

可选项：

- `STUDIO_MAIL_MODE=off|smtp`：默认 `off`（界面如实显示“未配置”，邀请与重置链接仍可复制）；SMTP 另需 `STUDIO_MAIL_HOST` 等变量。
- `STUDIO_OIDC_*`：单 IdP OIDC/SSO；`STUDIO_OIDC_ISSUER`、`STUDIO_OIDC_CLIENT_ID`、`STUDIO_OIDC_REDIRECT_URI` 同时存在才启用，回调为 `https://<公开地址>/api/auth/oidc/callback`。
- `STUDIO_AUTOMATION_RUNNER=1|0`：无人值守 runner 随 API 进程运行，默认开启；作业仍需在界面创建授权。
- `STUDIO_MODEL_ENDPOINT_ALLOW_PRIVATE=1|0`：默认 `0`。模型端点（新建、修改、拉取模型列表、连接测试、嵌入探测）默认拒绝本机、内网与保留地址；要用宿主机 Ollama（`http://host.docker.internal:11434/v1`）或局域网推理端点时设为 `1`。云元数据与链路本地地址（`169.254.0.0/16`、`fe80::/10`）始终拒绝，该开关不能放行。
- `STUDIO_LOG_LEVEL`：默认 `info`。

注意事项：

- Compose 不会自动读取 `.env.studio`，**每条命令都要带 `--env-file .env.studio`**；否则会回退到仓库的开发 `.env`。
- 修改 `STUDIO_DB_PASSWORD` 不会修改已有数据卷中的数据库密码；修改 `STUDIO_MODEL_KEY_SECRET` 会让既有服务商 API Key 无法解密，必须在界面重新录入；修改 `STUDIO_SESSION_SECRET` 会让所有会话失效。
- 该文件包含真实密钥，已被 `.gitignore` 与 `.dockerignore` 排除，不会进入镜像。

## 四、首次启动

```bash
# 1. 校验配置
docker compose --env-file .env.studio -f docker-compose.studio.yml config --quiet

# 2. 构建并启动
docker compose --env-file .env.studio -f docker-compose.studio.yml up -d --build

# 3. 查看一次性任务与服务状态
docker compose --env-file .env.studio -f docker-compose.studio.yml ps
docker compose --env-file .env.studio -f docker-compose.studio.yml logs migrate bootstrap
```

首次构建通常需要数分钟。成功后：

- 迁移容器 `Exited (0)`；bootstrap 日志显示“首个所有者初始化完成”或“跳过初始化（未做修改）”。API 只有在 migrate 与 bootstrap 都成功退出后才会启动；bootstrap 失败时不会对外提供登录。
- API 与 Web 为 `healthy`；worker 为 `running`。
- 打开 `STUDIO_PUBLIC_ORIGIN`（默认 <http://localhost:8088>），用首个所有者邮箱和密码登录。
- 首次部署必须填写 `BOOTSTRAP_OWNER_PASSWORD`（至少 10 位）。创建成功后可以从 `.env.studio` 删除该变量；已有所有者时 bootstrap 在密码校验之前就会跳过，因此后续重启不会因密码缺失而失败。
- 全新工作区没有章节。所有者、主笔或作者点击“导入旧章”（页头或空态按钮），填写作品名、卷号、卷名，上传或粘贴 Markdown。
- 章节标题行格式为 `## 第1章 标题`（也接受 `#`–`######`）；只识别阿拉伯数字章节号，`第一章` 不会被识别。首个标题之前的内容不会导入，解析预览会提示行数。一次导入一个卷，最多 1000 章；前端单文件上限 18MB，提交前按 JSON 请求体检查 20MB，nginx 与服务端上限均为 20MB。文件必须是 UTF-8，非 UTF-8 会显式提示转码，不会静默替换为乱码。
- 导入章以 `source=import` 的 canon v1 入库，`evaluation_id` 为空，界面门禁显示“未评估”。若工作区已有启用的 `embedding` 服务商，导入章索引状态为“等待索引 worker”，并写入 `index.chapter` outbox（可能产生嵌入调用费用）；若没有，则显示“未配置嵌入服务”。系统不会补造门禁结论，也不会自动生成草稿。需要修订时从“开始修订”进入正常提交链。
- 同一请求内章节号重复会被拒绝；作品内已存在章节号时整批不写入并返回 409。卷号已存在但卷名不同也返回 409 `VOLUME_TITLE_MISMATCH`，避免把新卷内容静默并入同名旧卷。导入后可再登记模型服务商：页头“模型服务商”，用途选择 `chat` 或 `embedding`；服务商配置不在环境变量里。

快速检查：

```bash
curl -fsS http://localhost:8088/healthz
curl -fsS http://localhost:8088/api/health
```

`/api/health` 返回 `status=ok` 表示 API 与数据库均可用；数据库不可达时返回 503 `degraded`。

## 五、日常操作

```bash
# 状态与日志
docker compose --env-file .env.studio -f docker-compose.studio.yml ps
docker compose --env-file .env.studio -f docker-compose.studio.yml logs -f api worker

# 升级代码后重建并重启（迁移会先执行）
docker compose --env-file .env.studio -f docker-compose.studio.yml up -d --build

# 停止但保留数据
docker compose --env-file .env.studio -f docker-compose.studio.yml stop

# 停止并删除容器与网络（保留数据卷）
docker compose --env-file .env.studio -f docker-compose.studio.yml down
```

- **不要**在生产试点中执行 `down -v`，它会删除数据库卷。
- 升级、修改迁移或恢复备份前先做一次备份。
- Web 镜像是静态构建；修改前端后必须 `up -d --build web`（或整体重建）。

## 六、备份与恢复

备份脚本复用仓库现有实现，容器名改为 `yunshuo-studio-db`：

```bash
YUNSHUO_DB_CONTAINER=yunshuo-studio-db YUNSHUO_BACKUP_DIR=backups \
  bash scripts/backup-db.sh
```

脚本执行 `pg_dump --format=custom`，用 `pg_restore --list` 校验可读性，并在文件小于 1KB 时失败；有 `sha256sum` 时生成校验文件。备份到 `backups/`（已 gitignore）。

恢复（先停止 API 与 worker，避免写入）：

```bash
docker compose --env-file .env.studio -f docker-compose.studio.yml stop api worker web
docker exec -i yunshuo-studio-db \
  pg_restore -U yunshuo -d yunshuo --clean --if-exists < backups/yunshuo-<时间>.dump
docker compose --env-file .env.studio -f docker-compose.studio.yml start api worker web
```

- dump 内含加密后的服务商 API Key 密文；恢复后必须使用**同一个** `STUDIO_MODEL_KEY_SECRET`，否则密钥无法解密。
- 备份文件本身包含全部业务数据与密钥密文，按敏感数据保管。
- 自动定时备份、异地存放与保留策略尚未接入；目前需手动执行。

## 七、HTTPS 与反向代理

Compose 交付的 web 容器只监听 HTTP 80，**不包含 TLS 证书管理**。公网/内网正式使用应在前面加一层 HTTPS 反向代理（Caddy、nginx、Traefik 或云负载均衡），转发到宿主机的 `${STUDIO_HTTP_PORT}`。

- 将 `STUDIO_PUBLIC_ORIGIN` 设为外部 HTTPS origin，并保证 OIDC 回调与 IdP 登记值完全一致。
- 生产模式下会话 Cookie 带 `Secure`：除 `localhost` 验收外，必须通过 HTTPS 访问，否则登录无法保持。
- 外层代理应设置 `X-Forwarded-Proto`；Compose 内 nginx 会透传该值，API 以 `TRUST_PROXY=1` 读取真实客户端 IP 用于登录限流。
- 外层代理需要为 SSE 关闭响应缓冲，并把读超时设到足够长（Compose nginx 已设 3600 秒）。

## 八、排障

| 现象 | 排查 |
| --- | --- |
| `migrate` 失败，api/worker 不启动 | `logs migrate`；确认 `STUDIO_DB_PASSWORD` 为 URL 安全字符，数据库卷未被旧密码初始化 |
| `/api/health` 503 | `logs db api`；确认 db 为 healthy、`DATABASE_URL` 未被宿主机环境覆盖 |
| 登录成功但刷新后退出 | 是否通过非 localhost 的 HTTP 访问；生产 Cookie 需要 HTTPS |
| 页面 404 / 刷新路由 404 | 确认使用的是 web 容器而非直接访问 API；nginx 已配置 SPA 回退 |
| AI 提案不是逐字出现 | 外层代理是否缓冲 SSE；检查浏览器 Network 的 `text/event-stream` |
| 邀请邮件显示“未配置” | `STUDIO_MAIL_MODE=off`；复制一次性链接，或配置 SMTP |
| 服务商密钥全部不可用 | `STUDIO_MODEL_KEY_SECRET` 是否被更换或与备份时不一致 |
| worker 无 healthy 状态 | worker 没有 HTTP 健康端点，这是预期；用 `logs worker` 确认 `[worker] started` 与索引轮询 |

## 九、验收记录

验收环境：Windows 10/11 + Docker Desktop，2026-10-22，本机 `http://localhost:8088`。以下均为实际执行结果。交付复审发现的问题、修复与残留风险见 `docs/云说-Studio交付回顾审计报告-2026-10-22.md`。

| 项目 | 结果 |
| --- | --- |
| Compose 配置 | `docker compose ... config --quiet` 通过 |
| 镜像构建 | `yunshuo-studio-api:local`、`yunshuo-studio-web:local` 均构建成功 |
| 迁移 | `migrate` 一次性容器 `Exited (0)`；重复启动不重复执行迁移 |
| 首次所有者 | bootstrap 创建 1 个 owner、1 个工作区；第二次执行检测到已有所有者，跳过且退出码 0 |
| 健康检查 | `/api/health` 返回 `{"status":"ok","database":"ok"}`；Web `/healthz` 返回 `ok`；api/web 为 `healthy`，worker 已启动 |
| 端口暴露 | 仅 web 发布 `8088:80`；api 与 db 无宿主机端口映射 |
| 登录 | 浏览器用 bootstrap 所有者登录成功，页头与空工作区正确渲染 |
| 旧章导入 | 全新空工作区导入 Markdown 两章成功；章节目录显示两章，详情显示门禁“未评估”、索引“未配置嵌入服务”、版本来源“迁移导入”，`canon_versions.source=import` 且 `evaluation_id` 为空 |
| 导入冲突 | 重复导入已存在章节号返回 HTTP 409 `CHAPTER_NUMBER_EXISTS`，提示“本次未写入任何章节”；数据库仍为原两章 |
| 备份 | `scripts/backup-db.sh` 生成 `yunshuo-20261022-100313.dump`（131674 字节）与 `.sha256`，`pg_restore --list` 校验通过 |
| 恢复演练 | 备份恢复到临时库 `yunshuo_studio_restore_test`，核对 1 用户 / 1 工作区 / 2 章节 / 2 个 `source=import` 版本后删除临时库 |
| 自动化 | `pnpm typecheck` 通过；`pnpm test` 20 个测试文件、151 个测试全部通过，其中 `apps/api/src/chapter-import.test.ts` 覆盖 8 个导入场景 |
| 交付复审（同日） | 使用临时端口 18088 重新构建并启动全栈：bootstrap 首次创建后退出 0、API 等待其成功后才 healthy、worker 带 `MODEL_KEY_SECRET` 启动；从 `.env.studio` 移除密码后二次执行 bootstrap 仍退出 0 并跳过；生产模式缺少模型密钥或模型密钥等于会话密钥时 API/worker 均拒绝启动（实际命令验证）；Compose 配置确认 worker 注入模型密钥、api 依赖 bootstrap 成功 |
| 清理 | 验收后 `down -v` 删除 Studio 容器、网络与数据卷；删除临时 `.env.studio` 与备份目录；开发库 `yunshuo-db`（5433）未受影响 |

未验收项：真实 IdP 的 OIDC 浏览器流程、真实 SMTP 投递、Linux 主机与外部 HTTPS 反向代理、长时间运行与多实例。不要将本记录视为这些项目的验收。

## 十、诚实边界

- **这是单机试点部署，不是高可用生产平台**：单数据库、单 API、单 worker、单 runner；没有多副本、负载均衡、零停机升级或故障转移。
- **没有内置 TLS、WAF、DDoS 防护或公网加固**；对外使用必须自行加 HTTPS 反向代理并限制访问面。镜像未做签名、SBOM 或漏洞扫描。
- **没有自动备份与自动恢复演练**；备份需手动执行，恢复需要停机。迁移只向前，不提供自动回滚。
- **数据库隔离仍是应用层 `workspace_id` 查询**，未启用 PostgreSQL RLS；登录限流是单进程内存，重启清空且多实例不共享。
- **镜像内用 `tsx` 直接运行 TypeScript**，API/worker 镜像包含开发依赖，不是最小化生产运行时；这是可审计与交付速度的取舍。
- **worker 没有 HTTP 健康端点**，Compose 只能确认进程在运行；索引是否推进要看日志与界面状态。
- **SMTP 真实发信路径尚未对真实邮件服务器验收**；默认 `off`。OIDC 的浏览器验收仍未对真实 IdP 执行。
- **本机验收使用 Docker Desktop（Windows）**；Linux 服务器上的路径权限、防火墙、SELinux 与宿主机 Ollama 可达性未实测。
- **旧章导入的 1000 章 / 20MB 边界已在隔离测试库实测，但不在本部署形态内**：用合成正文在指向 `yunshuo_test` 的宿主机独立实例上跑过（单批 1000 章 × 6500 字、请求体 18.15MB，单事务 4939ms，同一配置四次独立运行 4157/4413/4735/4939ms，无超时无 500；见 `docs/m6-perf-max-payload.json`）。**Studio 容器内、真实小说正文、浏览器预览性能与多用户并发仍未测**，不能把这些读数当成本部署的容量承诺。千章规模的**正典索引排空与混合检索**同样已在同一台宿主机、同一个隔离库上实测（真实 worker + 本机 Ollama `bge-m3`：导入 1000 章后 2070s 排空＝29.0 章/分钟、2000 切块全部出向量、检索词法 209–413ms / 混合 251–465ms；见 `docs/m6-perf-index.json`），但那条吞吐等的是本机单次嵌入调用的 2021ms 中位延迟，换服务商就会换数，也不代表 Studio 这套容器形态；同一部千章作品上的**千章账本索引**也在同一台宿主机、同一个隔离库实测过（`scripts/m6-perf-ledger-index.mjs`，报告 `docs/m6-perf-ledger.json`：发布 1000 条条目零失败，窗口内 978 条用 2359.9s 排空＝24.87 条/分钟，1914 个账本切块全部出向量、`attempts` 最大 1，账本通道检索词法 236–503ms / 混合 295–531ms，域外查询按账本通道单独降级）。**这两段速率都不是单 worker 吞吐**：报告自带采样里同时在处理的索引任务，正典阶段最多 989 条、上一轮 1000 条，而单个实例一次只领 10 条并逐条 await，说明当时有多个历史遗留的 worker 在领同一张 outbox（已按 PID 清理，详见 `docs/云说-M6回顾审计报告-2026-10-22.md` 7.6）；它们只能读成这台机器上的端到端聚合排空速率，换部署形态、换嵌入服务都要重测。前端文件选择上限为 18MB，服务端/nginx 为 20MB。只接受 UTF-8，不自动识别 GBK/GB18030；只解析阿拉伯数字章节号。导入不解析卷内章节顺序之外的排版，也不补造门禁或草稿。
- **导入前端没有自动化测试**：解析、编码提示、20MB 预检和自动索引费用提示目前依赖人工验收与类型检查。自动索引只在导入时提示可能产生费用，没有二次确认；没有嵌入服务商时不会排队。
- **复审未覆盖真实嵌入服务商的导入索引闭环**：自动排队与 outbox 已由集成测试验证，worker 的实际嵌入调用沿用 M4-A 的真实嵌入验收，但没有在本次 Studio 栈中配置外部嵌入服务复验。
- 部署成功不代表真实生产门禁已就绪：新建空工作区需先导入旧稿或从修订流程开始；导入章不带门禁结论，`dev-v0` 仍是演示规则集，不是生产规则。
