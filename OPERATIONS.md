# Waypoint 运维手册

> 面向接手运维这个平台的人。回答三个问题：**日常要做什么、改东西走什么流程、出事怎么查。** 业务模型见 `WIKI.md`，能力清单见 `CURRENT_CAPABILITIES.md`，本文只讲运维。

## 五分钟上手

```bash
git clone https://github.com/BinShun/Waypoint.git
cd Waypoint
npm start          # http://localhost:8787 —— 服务器零依赖，不需要 npm install
```

- **没有任何用户时**：应用直接打开（fresh 模式），第一个创建的账号是 Admin
- **有用户时**：登录框输入邮箱样式地址（如 `tehbinshun@global.tencent.com`），`@` 前缀按姓名匹配
- **想先看看**：登录屏的 sample workspace 按钮进入 Guest 模式（只读演示书，带 SAMPLE 标记）

跑一遍回归确认手里这份代码是完整的（约 10 分钟）：

```bash
WP_PASS='你的测试密码' npm run verify:all    # 28 套件 / 1420 checks，全绿 = 可交付状态
```

`WP_PASS` 需 8 位以上、含字母和数字——这是服务器本身的密码策略，套件会用它建临时管理员。

## 东西都在哪

| 东西 | 位置 | 说明 |
|---|---|---|
| 前端 | `Waypoint-v1.html` | 单文件，全部 UI 与逻辑，**无构建步骤** |
| 部署产物 | `dist/index.html` | 前端的副本，**服务器实际服务的是它** |
| 服务器 | `server/` | 零依赖 Node，一个端口同时给静态页和 `/api/*` |
| 数据 | `data/workbench.json` | 整个团队一本书；改它前先备份 |
| 回归套件 | `scripts/verify-*.mjs` | 28 个，行为规格就在测试里 |
| 模型凭据 | `.env`（可选） | 不进 git |
| HTTPS 证书 | `certs/`（可选） | 不进 git |

**数据不进 git**（`data/`、`certs/`、`.env` 都在 `.gitignore` 里）。这意味着：**换机器 / 重新 clone 后，数据要单独迁移**——拷贝整个 `data/` 目录即可。

## 日常任务

### 账号管理

| 任务 | 做法 |
|---|---|
| 建用户 / 改角色 | Admin 登录 → Admin 屏 → People |
| 重置某人密码 | `npm run set-password -- --user "姓名" --password '新密码'`（停掉持有旧状态的浏览器标签页再执行，否则旧标签会把凭据推回去） |
| 锁定账号 | Admin 屏将该用户锁定（服务端强制，立刻生效） |
| 演示账号 | `npm run seed:demo`——四角色 + 密码统一 `Waypoint#2026`，**只用于演示，别用于生产** |

密码存储是 PBKDF2（150k 迭代、独立盐），忘记的密码**读不回来**，只能重置。

### 数据：备份与恢复

```bash
npm run backup:live      # 备份 data/workbench.json（带时间戳进 data/backups/）
npm run restore:live     # 从最近一次备份恢复
```

建议节奏：**任何手工干预数据之前备份一次；日常按团队改动频率，每天或每周一次**。保存本身是原子的（写临时文件 + rename，断电不坏账），并发保存走 rev 合并而非覆盖——正常运行期间不需要额外操心。

### 静态加密（可选）

```bash
WB_DATA_KEY='base64 密钥' npm start    # 之后保存的文件即加密
```

**注意**：加密是保存时应用的。开钥匙后第一次全量保存才落密文；`verify:encryption` 套件验证机制本身。密钥丢了数据就丢了——把密钥和备份放在不同的地方。

### AI 配置（完全可选）

不配模型，应用每个功能照常工作（AI 入口显示「No model connected.」并指路 Admin 屏）。两种配法任选：

1. `.env` 文件：`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`（字段说明见 `server/server.mjs` 头注）
2. 界面：Admin 登录 → Admin 屏 → AI & model

任何 OpenAI 兼容端点（`/v1/chat/completions`）都能接。预算与超时在 Admin 屏设置。AI 的八条行为边界见 `WIKI.md`——运维者最该知道的一条：**模型只能看到调用者本人可见的数据，confidential 客户的数据在服务端就被拦下，永不出门。**

### HTTPS

```bash
npm run make-cert      # 生成自签证书进 certs/，服务器自动切 https
```

正式域名部署建议前置反代终结 TLS，后端保持 http。

### 发布到公网 / 反代后面

浏览器的 Origin 校验会拒绝未知来源的保存。把公开域名加进白名单，二选一：

- `server/published-origins.txt` 里加一行域名
- 环境变量 `WB_ORIGINS=https://你的域名` 或 `WB_ORIGIN_SUFFIX=.你的后缀`

绑定全部接口：`HOST=0.0.0.0 npm start`（或 `npm run server:lan`）。

## 改东西的正确流程（验证先行）

这个项目的惯例：**先加断言，再动实现**。每一步都有套件盯着，红的就是说明，不是障碍。

```bash
# 改前端
vim Waypoint-v1.html
npm run artefact          # 同步 dist/index.html —— 忘了这步，服务器还在发旧页面
WP_PASS='...' npm run verify:all

# 改服务器
vim server/server.mjs
WP_PASS='...' npm run verify:all
```

**最常见的坑**：改了 `Waypoint-v1.html`，测试全绿，但浏览器看到的还是旧页面——因为服务器从 `dist/` 服务。`npm run artefact`（或手动 `cp Waypoint-v1.html dist/index.html`）解决。

新增能力时：在对应套件加断言，或建新套件并注册进 `scripts/verify-all.mjs` 的 SUITES 数组。套件清单本身就是这个应用的行为规格。

单跑一个套件：`WP_PASS='...' npm run verify:switch`（身份切换）、`verify:server`（API 守卫）、`verify:roles`（角色矩阵）……全量清单见 `package.json`。

## 故障排查

| 症状 | 原因 | 处置 |
|---|---|---|
| 登录报 Incorrect password | 密码错，或密码不符合策略（8+ 位、含字母数字） | `npm run set-password` 重置 |
| 保存被拒 / 请求 403 | 反代域名不在 Origin 白名单 | `server/published-origins.txt` 加域名，或设 `WB_ORIGINS` / `WB_ORIGIN_SUFFIX` |
| 套件报端口被占 | 上次运行的测试服务器没退干净 | 报错信息里直接给出占用进程的 pid——`kill 那个pid`；**不要**用宽泛的 `pkill -f "node server"`（会误杀别的服务器，甚至杀到执行清理的 shell 自己） |
| `verify:all` 大面积红 | `WP_PASS` 未设或太弱 | 用 8+ 位含字母数字的密码重跑——套件开局就校验并说明原因 |
| 改了前端没生效 | `dist/` 没同步 | `npm run artefact` |
| AI 入口全灰 | 未配置模型 | Admin 屏配置，或 `.env`；这不是故障，是诚实显示 |
| AI 请求超时 | 端点慢或不可达 | 检查 `AI_BASE_URL` 可达性；90s 硬超时是设计行为，任务中心可重试 |
| 「记住此设备」不记得了 | 登出会双侧吊销 token（设计如此），或服务器重启（会话在内存） | 重新登录勾选——安全语义优先于便利 |
| 换账号后看到旧账号的 AI 回答 | **这不该发生** | 套件 `verify:switch` 专管此事——跑它，红了就是回归，修了再交付 |

## 安全清单（运维者自查）

- [ ] 生产数据目录 `data/` 有备份，且与 `WB_DATA_KEY`（若启用）分开存放
- [ ] 演示密码 `Waypoint#2026` 没有出现在任何生产账号上（`seed:demo` 只用于演示环境）
- [ ] 公网部署的域名已在 Origin 白名单，`HOST=0.0.0.0` 只在反代后使用
- [ ] `data/`、`certs/`、`.env` 没被提交进 git（`git status` 里看不到它们即正常）
- [ ] 交付前 `verify:all` 全绿（28 套件 / 1420 checks）

## 从这里去哪

- 想懂业务规则 → `WIKI.md`
- 想知道现在有什么功能 → `CURRENT_CAPABILITIES.md`
- 想知道某个行为为什么是这样 → 先查 `scripts/verify-all.mjs` 的套件描述，再读对应套件源码——注释里写着每条规则存在的原因
