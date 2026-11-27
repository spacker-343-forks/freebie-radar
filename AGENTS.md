# AGENTS.md — `scys-radar` 项目协作与维护指南

## 1. 项目概览

`scys-radar` 是基于上游开源项目 [ZiChuanLan/freebie-radar](https://github.com/ZiChuanLan/freebie-radar) 增量定制的**生财有术（`scys.com`）MCP 商业情报脱水雷达与本地实战知识库**。

核心目标：
- 通过生财有术官方 MCP 接口自动抓取精华帖、风向标、中标案例、项目库、最新动态与历期大航海实战手册，并以 **最高 50 万字符无损全文**（含飞书关联文档与精选评论）永久归档至本地 SQLite，防止原帖删除后失联。
- 利用高阶推理模型完成水帖/软广拦截、`[底牌门槛]` 提炼、结构化主编日报/周报合成、≥4 星干货《⚡ AI 实战立项拆解书》深度精读，以及跨百帖《🧭 赛道实战白皮书》聚类提炼。
- 保持对上游核心文件（尤其是数据库迁移序列与自更新器）的低侵入性，同时每天用 AI 自动巡检上游仓库更新，发现值得吸收的重大通用功能时在网页顶部弹出合入提醒。

---

## 2. Git 仓库与双分支约定

- **`origin`（自有仓库）**：`https://github.com/spacker-343-forks/freebie-radar.git`
- **`upstream`（源头仓库）**：`https://github.com/ZiChuanLan/freebie-radar`
- **分支职责**：
  - **`main` 分支**：严格保持与上游 `upstream/main` 一致的纯净基线，**禁止直接向 `main` 提交生财定制代码**。
  - **`scys-radar` 分支**：日常开发、部署与定制功能所在的主力分支。
  - **吸收上游更新命令**（在 `scys-radar` 分支执行）：
    ```bash
    git fetch upstream
    git merge upstream/main
    ```

---

## 3. 技术栈与核心目录地图

- **后端**：Node.js `>=22.5`（原生内置 `node:sqlite`，WAL 模式单文件库 `data/radar.db`）+ TypeScript (`tsx`) + Hono (`src/server/`)
- **前端**：React 19 + Tailwind CSS v4 + Lucide Icons + Vite 7 (`src/web/`)
- **前后端共享契约**：`src/shared/`

### 生财定制与扩展模块索引

| 模块路径 | 职责说明 |
| :--- | :--- |
| `src/server/scys/mcp-client.ts`<br>`scripts/scys-auth.ts` | 生财 MCP (`https://mcp.scys.com/shengcai-web/mcp`) Stateless Streamable HTTP 客户端、OAuth 2.1 + PKCE + DCR 登录续签、`Mcp-Session-Id` 过期重连及多槽位并发连接池（存于 `settings.scys_mcp_auth`）。 |
| `src/server/collectors/scys.ts` | 生财两阶段采集器（Stage 1 列表检索 + Stage 2 并发详情补全），支持 50 万字无损归档与旧版 `8,000` 字截断记录自动重抓自愈。 |
| `src/server/enrich/ai-settings.ts` | 支持 `<model>:<effort>`（如 `gpt-6.2-sol:high`，自动映射 `reasoning_effort` 并省略 `temperature`）、HTML 标签清洗与 6,000 字送审窗口、主端点配额耗尽自动 6h 熔断切换至 `AI_FALLBACK_BASE_URL`、以及深度模型路由 `resolveDeepModel`。 |
| `src/shared/digest.ts`<br>`src/server/digest.ts`<br>`src/web/src/components/DigestPanel.tsx` | AI 主编结构化每日精选与周报（独立拆分 `threshold` 底牌门槛字段、候选池真实链接覆写防幻觉、兼容解析旧版纯文本、移动端「站内读全文 + 生财原帖」双胶囊）。 |
| `src/web/src/lib/snapshot.ts`<br>`src/web/src/components/SnapshotContent.tsx` | 零 XSS 白名单正文快照阅读器：自动识别生财 Tiptap HTML 与 Markdown，渲染标题、图文、可复制代码块、飞书文档与精选评论卡片。 |
| `src/shared/dossier.ts`<br>`src/server/dossier.ts`<br>`src/web/src/components/DossierCard.tsx` | ≥4 星干货《⚡ AI 实战立项拆解书》：吃入最高 3 万字纯文本提取算账公式、去水分 SOP、核心死穴与单人 MVP 改法（独立幂等表 `item_dossiers`）。 |
| `src/shared/tracks.ts`<br>`src/server/tracks.ts`<br>`src/web/src/components/TracksPanel.tsx` | 《🧭 赛道全景图谱》频道：跨百帖自动聚类核心赚钱赛道并合成白皮书（流派 ROI 对比、高频死法、7 天验证清单与代表神帖，独立幂等表 `scys_tracks`）。 |
| `src/shared/upstream-watch.ts`<br>`src/server/upstream-watch.ts`<br>`src/web/src/components/UpstreamWatchBanner.tsx` | 每日自动巡检上游 `ZiChuanLan/freebie-radar` 未合入提交，由 AI 评估是否含重大通用特性并在首页顶部弹横幅公告，同时在 `OpsPanel.tsx` 提供手动巡检卡片。 |

---

## 4. 常用命令与运行环境约定

```bash
# 日常开发与检查门禁
pnpm typecheck          # TypeScript 全量类型检查
pnpm test               # Node 原生测试运行器（全量隔离单测）
pnpm i18n:check         # 前端中英文词条覆盖率检查
pnpm build              # 类型检查并构建前端静态产物至 dist/web/
pnpm start              # 启动线上 Hono 服务（默认端口 8788，托管 dist/web/）

# 生财专用工具链
pnpm scys:auth          # MCP 登录授权（--add 追加并发槽位，--status 查看槽位）
pnpm scys:preset        # 幂等初始化生财数据源开关、脱水 Prompt、屏蔽词与 10 年保留期
pnpm scys:backfill      # 多分区分页历史回溯与流式 AI 脱水（支持断点续跑）
pnpm scys:manuals       # 遍历历期大航海目录，无损抓取全部实战手册章节（支持偏移续传）
pnpm scys:burn          # 批量合成《赛道实战白皮书》(--tracks) 与《实战立项拆解书》(--dossiers)
```

- **本机运行与公网固定入口**：Web 服务监听 `8788` 端口，本机已配置 Windows 后台常驻 **Tailscale Funnel**（`tailscale funnel --bg 8788`），公网手机免装 App 直连固定地址：`https://asus.tail340fba.ts.net/`。
- **日常稳态 AI 配置**：通过本地 `.env`（gitignored）与 `settings.ai_settings` 连接本机兼容网关（`http://127.0.0.1:8317/v1`），日常增量采集默认采用高性价比 `gpt-6.2-sol:high`（`batchSize=4`）；数据保留策略设为 `3650` 天且关闭自动清理（`auto=false`）。

---

## 5. Agent 修改代码硬性护栏（必读）

1. **严禁破坏 `db.ts` 上游迁移序列**：
   - 绝对不要往 `src/server/db.ts` 的 `MIGRATIONS[]` 数组追加新序号，以免后续 `git merge upstream/main` 时与上游新迁移发生版本号冲突。
   - 新增业务存储统一使用独立幂等建表（`CREATE TABLE IF NOT EXISTS ...`）或写入 `settings` 键值表。
2. **严禁污染或清空真实数据库**：
   - `./data/radar.db` 存放着上万篇无损原文与数千份 AI 精炼资产，严禁在调试或测试中删除/重置该文件。
   - 编写或修改 `tests/*.test.ts` 时，必须在导入业务模块前将 `process.env.DATABASE_PATH` 指向独立临时目录，并清空测试进程中的 `AI_API_KEY` / `AI_FALLBACK_*` 等环境变量，确保单测离线可重现。
3. **前端改动必须同步构建与补齐 i18n**：
   - `pnpm start` 直接托管 `dist/web/` 静态产物；修改任何 `src/web/` 或被前端引用的 `src/shared/` 文件后，**必须重新执行 `pnpm build`**。
   - 新增 UI 中文文案务必用 `t("...")` 包裹并同步补入 `src/web/src/lib/i18n/en/` 对应词典。注意 `scripts/i18n-check.mjs` 会扫描 `.ts`/`.tsx` 引号字符串中的中文，编写文本解析匹配时请使用正则字面量 `/.../` 而非中文引号字符串。
4. **密钥与隐私红线**：
   - 严禁将 `.env`、任何真实 API Key、`ADMIN_TOKEN`、OAuth Token、`data/radar.db*` 或 `data/scys-tools-schema.json` 硬编码或提交进 Git 仓库。
