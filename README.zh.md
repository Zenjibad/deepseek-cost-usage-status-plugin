# DeepSeek 成本 / 用量 / 状态插件（DeepSeek Harness）

这是为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 编写的一个**打包式 Cordis 插件**：在对话输入区自带的统计行下方，新增一行带颜色的状态行，实时展示 **DeepSeek API 成本、用量与账户余额**。

```
● Off-peak 00:47 · −50%  ·  Cost ¥0.0412  ·  ~¥1.23/min  ·  Balance 12.42 CNY  ·  Model deepseek-v4-flash
```

## 功能

- **空闲 / 高峰指示** —— 空闲（off-peak）为**绿色**，高峰（peak）为**红色**，采用 DeepSeek **官方北京时间高峰时段**（09:00–12:00、14:00–18:00）。时钟显示**你的本地时区**；红绿判定按北京时间，因此颜色与实际计费一致。
- **会话成本** —— 通过拦截 `llm/stream` 瀑布流累计本会话真实 token 用量，按**官方人民币（CNY）价格**并计入**闲时 50% 折扣**计算。
- **烧钱速率** —— `~¥/min`（USD 则 `~$/min`），即会话成本 ÷ 从首次模型调用起的分钟数。
- **账户余额** —— 每 60 秒调用 DeepSeek `/user/balance`（复用 DSH 自身 `DEEPSEEK_API_KEY`）；无法读取密钥/网络异常时优雅降级为 `Balance —`。
- **当前模型 + 推理强度**。
- **字体与自带统计行一致**（12px/20px、弱化三级文字色、居中）。

## 快速开始

本插件是**打包式 profile 插件**——用官方 CLI 安装一次，之后每次启动 DSH 都会自动加载，重启不丢失（无需 `cordis_define`）：

```sh
dsh plugin --profile web add deepseek-cost-usage-status-plugin
# 或从本地仓库安装：
dsh plugin --profile web add ./deepseek-cost-usage-status-plugin
```

然后**重启 DSH**。插件渲染在 `conversation.composer.dock` 槽位（在自带 `stats` 单元旁新增一行），数据来自 `GET /deepseek-cost/api`。

## 依赖

- DSH 0.1.0-rc.6+（需 Web UI，且已配置 DeepSeek 供应商）。
- 在 `~/.dsh/.credentials.yaml` 中存有 `DEEPSEEK_API_KEY`（用于读取余额）。没有密钥时余额显示 `—`，其余功能仍正常。

## 工作原理

- **Host 半部**（数据源）：包装 `llm/stream` 瀑布流（透传、不破坏流式语义），每次调用结束后读取 `usage` 块，按会话累计 token/模型/时间，用 `PRICING` 表（官方 CNY、高峰价；闲时 50%）与北京时间高峰判定计算成本，并通过 `curl.exe` + `subprocess` 轮询余额。通过 **`GET /deepseek-cost/api`**（`webServer` 路由——打包式插件替代动态 `harness.handle` RPC 的方案）提供快照。
- **Client 半部**：注册到 `conversation.composer.dock`，每 2 秒轮询 `/deepseek-cost/api`，渲染与自带统计行同字体的红/绿高峰指示行。

## 定价表（官方 CNY，每百万 tokens，2026-08-17 生效）

| 模型 | | 缓存命中输入 | 缓存未命中输入 | 输出 |
| --- | --- | --- | --- | --- |
| **deepseek-v4-flash** | 闲时 | ¥0.05 | ¥1.5 | ¥4.5 |
| | 高峰 | ¥0.10 | ¥3.0 | ¥9.0 |
| **deepseek-v4-pro** | 闲时 | ¥0.15 | ¥4.5 | ¥13.5 |
| | 高峰 | ¥0.30 | ¥9.0 | ¥27.0 |

价格变动时只改 [`src/index.ts`](./src/index.ts) 里的 `PRICING` 一处即可。

## 常见问题

- **显示 `Cost …` / `Balance —`？** Host 路由不可达、缺少密钥（`~/.dsh/.credentials.yaml` → `DEEPSEEK_API_KEY`）、或余额调用失败（网络 / 非 200）。余额不可用时成本与高峰指示仍正常，下一次轮询会自动恢复。
- **为什么读取余额要把 API key 放到 curl 命令行上？** key 以 `Authorization` 头参数传给 `curl.exe`（本机其他进程可见）——这是该只读工具接受的取舍。插件本身不会存储或记录该 key。
- **账户按美元结算？** `api.deepseek.com` 按人民币计价；若你的账户按美元结算，请相应调整模型 `currency` 字段与成本显示。

## 目录

- `src/index.ts` — Host 半部（瀑布流包装、定价、余额轮询、`/deepseek-cost/api` 路由）。
- `src/client/index.tsx` — Client bundle（2 秒轮询、统计行）。
- `cordis.patch.yml` — `dsh.bundle.patch`：启动时挂载插件行。
- `tsdown.config.ts` — 构建 Host（node ESM）+ Client（CJS ModuleLoader 闭包）。
- `tests/fixtures/balance.json` — `/user/balance` 响应样例。
- `AGENTS.md` — 面向 AI agent / 维护者的指引。
- `README.md` — 英文文档。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
