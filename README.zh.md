# DeepSeek 成本 / 用量 / 状态插件（DeepSeek Harness）

这是为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 编写的一个**动态 Cordis 插件**：在对话输入区自带的统计行下方，新增一行带颜色的状态行，实时展示 **DeepSeek API 成本、用量与账户余额**。

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

## 安装

本插件是**动态插件**，无静态 `cordis.patch.yml` 挂载。需在运行中的 DSH 会话里注册：

1. 在 **Package → Cordis** 插件面，或由本 agent 使用 `cordis_define`（`kind: 'new'`，任选 `idPrefix`）。
2. 把 [`package-source.js`](./package-source.js) 的 `host` 字段粘贴到 `code.host`，`client` 字段粘贴到 `code.client`。
3. `cordis_run` 定义好的 Package 并在界面确认。

插件会渲染在 `conversation.composer.dock` 槽位（在自带 `stats` 单元旁新增一行）。

## 依赖

- DSH 0.1.0-rc.6+（需 Web UI，且已配置 DeepSeek 供应商）。
- 在 `~/.dsh/.credentials.yaml` 中存有 `DEEPSEEK_API_KEY`（用于读取余额）。没有密钥时余额显示 `—`，其余功能仍正常。

## 定价表（官方 CNY，每百万 tokens，2026-08-17 生效）

| 模型 | | 缓存命中输入 | 缓存未命中输入 | 输出 |
| --- | --- | --- | --- | --- |
| **deepseek-v4-flash** | 闲时 | ¥0.05 | ¥1.5 | ¥4.5 |
| | 高峰 | ¥0.10 | ¥3.0 | ¥9.0 |
| **deepseek-v4-pro** | 闲时 | ¥0.15 | ¥4.5 | ¥13.5 |
| | 高峰 | ¥0.30 | ¥9.0 | ¥27.0 |

价格变动时只改 `package-source.js` 里的 `PRICING` 一处即可。

## 目录

- `package-source.js` — 插件本体（线上注册 Package 的镜像）。`host` → `code.host`，`client` → `code.client`。
- `docs/design.md`、`docs/plan.md` — 设计与计划。
- `AGENTS.md` — 面向 AI agent / 维护者的指引。
- `README.md` — 英文文档。

## 许可证

MIT，见 [LICENSE](./LICENSE)。

> 注：`api.deepseek.com` 按人民币计价；若你的账户按美元结算，请相应调整模型 `currency` 字段与成本显示。
