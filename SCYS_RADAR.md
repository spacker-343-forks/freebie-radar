# 生财有术信息脱水雷达 (`scys-radar`) 使用指南

`scys-radar` 基于上游 [ZiChuanLan/freebie-radar](https://github.com/ZiChuanLan/freebie-radar) 进行最小化增量适配：默认仅开启**生财有术 MCP (`scys-mcp`)** 数据源，并内置生财社群专用的 AI 脱水审核提示词与硬噪音拦截规则，方便后续通过 `git pull --rebase` 无冲突同步上游更新。

---

## 1. 数据源说明（默认仅开生财源）

初始化数据库后，非 `scys-` 的上游内置源默认全部关闭，仅启用以下 3 个核心生财源（可在后台「数据源运维」按需增删或调整频率）：

| Source ID | 名称 | 默认状态 | 采集间隔 | 说明 |
| --- | --- | --- | --- | --- |
| `scys-highlights` | 生财有术 · 精华与风向标 | 开启 | 30 分钟 | 精华帖与风向标中标，附带详情抓取 |
| `scys-projects` | 生财有术 · 项目库案例 | 开启 | 60 分钟 | 生财项目库拆解与案例 |
| `scys-latest` | 生财有术 · 最新帖子 | 开启 | 30 分钟 | 社区最新动态流 |
| `scys-manuals` | 生财有术 · 航海实战手册 | 关闭 | 120 分钟 | 航海期数与实战手册（可按需手动开启） |

---

## 2. 快速上手步骤

### 第一步：安装依赖与建表

```bash
pnpm install
pnpm migrate
```

### 第二步：生财有术 MCP 鉴权与工具检查

登录并验证 `scys-mcp` 会话凭据，确认 MCP 工具列表可用：

```bash
pnpm scys:auth
pnpm scys:tools
```

### 第三步：应用生财预设（数据源 + AI 脱水口径 + 屏蔽词）

```bash
pnpm scys:preset
```

该脚本幂等执行，不会覆盖你已经配置好的 `baseUrl`、`apiKey`、`model` 或 `enabled` 开关，主要完成：
1. 关闭所有非 `scys-` 数据源，确保开启 `scys-highlights`、`scys-projects`、`scys-latest`。
2. 写入生财有术专用脱水 `systemPrompt`：
   - 保留可执行 SOP、营收/成本拆解、踩坑复盘、AI Coding / SaaS 工作流（`kind="info"`）、开源仓库（`kind="opensource"`）、纯免费直领资源（`kind="freebie"`）及透明好价（`kind="deal"`）。
   - 拦截纯晒单喜报、加微领资料/私域引流软广、打卡鸡汤（`kind="noise"`）。
   - 通过 `obtain` 映射「前置底牌」门槛（`free` 零基础可试 / `conditional` 需编程或老号流量 / `paid` 需投流资金 / `promo` 合作含干货），并在 `reason` 中按 `[底牌门槛] 核心干货或拦截原因` 输出。
3. 幂等导入高精拦截词至 `block_rules`（如 `加我微信`、`私信领取`、`陪跑营招生`、`打卡第` 等）。

### 第四步：配置 AI 密钥并启动服务

`scys-preset` 与系统默认配置已预设 OpenAI 官方推理模型：
- 默认端点：`https://api.openai.com/v1`
- 默认模型：`gpt-6.1-terra:high`（支持 `<model>:<effort>` 或 `<model>@<effort>` 语法，如 `low`/`medium`/`high`/`xhigh`，请求时自动拆分为 `model` + `reasoning_effort` 并省略 `temperature`）
- 默认并发与超时：`batchSize = 4`、`concurrency = 3`、`timeoutSec = 75`（上限支持调至 `120` 秒，适配 `high` / `xhigh` 长文推理耗时）
- 兼容兜底：对于未识别的第三方模型，首次请求遇到 HTTP 400 且提示不支持 `temperature` 时，会自动去掉 `temperature` 重试一次。

在 `.env`（填写 `AI_API_KEY`，或覆盖 `AI_BASE_URL`/`AI_MODEL`）或界面「AI 引擎」中填入密钥并开启审核开关，然后启动：

```bash
# 手动触发一次全量采集
pnpm collect

# 启动后端服务与 Web 控制台（默认 http://127.0.0.1:8788）
pnpm build
pnpm start
```

> **默认落地频道**：生财有术的实战复盘、SOP 与项目拆解绝大多数归类为 `kind="info"`（行业资讯）或 `kind="opensource"`（开源项目）。`scys-radar` 已将顶部频道栏最前面调整为 **「行业资讯」**、**「开源项目」**，且打开首页 `http://127.0.0.1:8788/` 默认即进入 **「行业资讯」(`preset=info`, `hideRejected=1`)** 频道，自动过滤被 AI 拦截的水帖与软广；也可随时切换至 **「开源项目」**、**「真福利」(`preset=verified`)** 或 **「全部收录」(`preset=all`)**。

---

## 3. 常用命令速查

- `pnpm scys:auth`：生财有术 MCP 登录鉴权
- `pnpm scys:tools`：查看 `scys-mcp` 可用工具
- `pnpm scys:preset`：重置/同步生财源开关、AI 脱水提示词与全局屏蔽规则
- `pnpm collect`：立即执行一次启用的数据源采集
- `pnpm test`：运行全部测试
- `git pull --rebase origin main`：同步上游 `freebie-radar` 更新
