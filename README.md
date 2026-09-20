# Waypoint

腾讯云马来西亚团队的 **BD & SA 客户工作台**。一个客户一本书、一个团队一套账、AI 只在被按下时才说话。

- **单文件前端**（`Waypoint-v1.html`，无构建步骤）+ **零依赖 Node 服务器**（`server/`）
- 数据是**一个 JSON 文件**（`data/workbench.json`）：原子保存、带修订号、可选静态加密
- **AI 完全可选**：不配模型，应用的每个功能照常工作；配上模型，五个入口获得 AI 辅助

## 运行

```bash
npm start            # http://localhost:8787 —— 服务器零依赖，无需 npm install
```

| 场景 | 命令 |
|---|---|
| 局域网访问 | `npm run server:lan`（绑定 0.0.0.0） |
| 演示数据 | `npm run seed:demo`（四角色账号 + 一个走完整业务链的演示客户，密码统一 `Waypoint#2026`） |
| 重置某人密码 | `npm run set-password -- --user "姓名" --password '新密码'` |
| 备份 / 恢复 | `npm run backup:live` / `npm run restore:live` |
| 自签证书 | `npm run make-cert`（生成后服务器自动提供 https） |

**登录**：工作区没有任何用户时，应用直接打开（fresh 模式）；有用户则需登录。登录框输入邮箱样式地址（如 `tehbinshun@global.tencent.com`），`@` 前缀按姓名匹配账号。

## AI 配置（可选）

两种方式任选：

1. 环境变量：`.env` 文件设置 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`（参考字段见 `server/server.mjs` 头注）
2. 界面配置：Admin 登录 → Admin 屏 → AI & model，在线填写并保存

未配置时所有 AI 入口显示「No model connected.」并指路 Admin 屏，其余功能不受影响。

## 角色

| 角色 | 职责 |
|---|---|
| **Admin** | 全部能力 + 用户管理 + AI 连接与预算 |
| **Manager** | 只读全景：pipeline 总览、所有人客户的只读视图，无任何写入口 |
| **BD**（Account Manager） | 名下客户（owner）的全部业务动作 |
| **SA**（Solution Architect） | 被客户 owner 拉进 team 的客户的业务动作 |

另有一种**非核心成员**（Non-Core Member）：没有账号，只作为名字出现在记录里（可被指派完成 Next Step）——这是有意设计，上船须由客户 owner 把名字加进 team。

## 项目结构

```
├── Waypoint-v1.html      前端应用（单文件，全部 UI 与逻辑）
├── server/               零依赖 Node 服务器（静态服务 + API + AI 代理 + 加密）
├── dist/index.html       部署产物（前端副本，服务器的静态目录）
├── scripts/              25 个回归套件 + 验收走查器 + 运维工具
├── data/                 工作区数据（不进 git）
├── certs/                自签 https 证书（不进 git）
└── .env                  模型端点凭据（可选，不进 git）
```

## 测试与维护

```bash
npm run verify:all       # 25 套件 / 1296 checks，全绿才允许交付
```

维护要点：

- **改前端**：编辑 `Waypoint-v1.html` → `npm run artefact`（同步 `dist/index.html`）→ `npm run verify:all`
- **改服务器**：编辑 `server/*.mjs` → `npm run verify:all`
- **新增能力**：先在对应套件加断言（或新套件，并加入 `scripts/verify-all.mjs` 的 SUITES），再动实现——这是本项目「验证先行」的惯例
- 每个套件可单独跑：`npm run verify:server`、`verify:copilot`、`verify:roles`……完整清单见 `package.json`

## 环境变量速查

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | 8787 |
| `HOST` | 绑定地址 | 127.0.0.1 |
| `WB_DATA_DIR` | 数据目录 | `./data` |
| `WB_ORIGINS` / `WB_ORIGIN_SUFFIX` | 反代发布时的 Origin 白名单 | 读 `server/published-origins.txt` |
| `WB_TLS` | `0` 强制纯 http | 有证书即 https |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` / `AI_FAST_MODEL` / `AI_TIMEOUT_MS` / `AI_MAX_TOKENS` | 模型端点 | 无（AI 关闭） |
