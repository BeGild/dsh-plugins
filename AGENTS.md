# DSH 插件开发规范（本仓库）

> **本文件由 DSH 自动加载**：候选文件名 `AGENTS.md` / `CLAUDE.md`（本仓库用 `AGENTS.md`），
> 项目根标记 `.git`，总渲染预算 `maxBytes = 65536`，单文件上限 `maxSourceBytes = 1 MiB`。
> 在本仓库工作的任何 agent，**动手写插件前必须先读本文件**；这是规范，不是建议。

---

## 0. 本仓库是什么

`E:\work\dsh` 是 **DSH（DeepSeek Harness）插件开发工作区**，用于持续开发一系列插件。

一句话前提，决定了整个工作方式：

> **DSH 上游（`deepseek-ai/deepseek-harness`）不接受外部 PR**——它的 Issues 与 PR 功能是关闭的
> （API 实测 `has_issues: false` / `has_pull_requests: false`，仅 Discussions 开放）。
> 官方指定的贡献路径是：**插件放你自己的仓库 → 发 npm → 加 `dsh-plugin` topic → 收录进社区清单。**

所以本仓库的产物形态是**独立可安装的插件包**，不是对上游 `packages/` 的补丁。

**要提 PR 的仓库是 `awesome-dsh-plugin/awesome-dsh-plugin`（社区清单），不是上游。**

---

## 1. 铁律

违反任意一条 = 返工。

| # | 规则 |
|---|---|
| **R1** | 每个插件包**必须**在 `package.json` 声明 `dsh.bundle.patch`。**只声明 `dsh.client` 是最常见的被拒原因，且那样根本无法安装。** |
| **R2** | 每个插件包**必须**有一个 `cordis.patch.yml`，顶层是 YAML **数组**，行内 `name` 写**包名**（不是相对路径）。 |
| **R3** | 第三方插件**只交付自己的 bundle**。**绝不修改** profile 的 `package.json` / `cordis.patch.yml`（那是用户侧，由 `dsh plugin` 维护）。 |
| **R4** | 官方 `@deepseek-ai/*` 包一律用 `peerDependencies` 声明，**不要**放 `dependencies`。 |
| **R5** | peer 范围**必须**带显式预发布分支（见 §3.3）。写成 `>=0.0.1-rc.1 <0.2.0` 会**静默排除所有预发布版 DSH**。 |
| **R6** | **任何两个部署可能想设成不同值的量，都必须是 Config 字段**，不得硬编码常量。 |
| **R7** | 分发**优先发 npm**（或 `pnpm pack` 的 tarball）。GitHub 直装是下策（需用户手工 `allowBuilds` 授权安装期执行代码）。 |
| **R8** | 描述**必须属实**。清单维护者会拿描述逐句对着代码核。**夸大是让好插件被打回的主因。** |
| **R9** | 清单投稿**一个 PR 只加一个 YAML 文件**，且**最多 3 条**。 |
| **R10** | **不做纯聚合包**——内容只有一份依赖清单、自身无行为的 bundle **不单独收录**。 |

---

## 2. 插件是什么

插件本体 = **Cordis plugin**：导出 `apply(ctx)` 的模块。三种形态，默认用函数形态：

```ts
// 函数形态（默认）
import type { Context } from '@deepseek-ai/cordis'
export const name = 'my-plugin'
export const inject = ['tools']          // 声明依赖，框架会等服务就绪再调 apply
export function apply(ctx: Context) { /* 注册能力 */ }
```

```ts
// 对象形态
export default { name: 'my-plugin', inject: ['tools'], apply(ctx: Context) {} }
```

```ts
// 类形态 —— 仅当你的插件对外「提供服务」时
import { Service, type Context } from '@deepseek-ai/cordis'
export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) { super(ctx, 'myService') }
}
```

**自动清理**：通过 `ctx` 注册的一切（`ctx.on()` / `ctx.tools.register()` / `ctx.effect()`）在插件卸载时自动回滚，**不要手写 `removeListener` / `clearInterval`**。需要显式清理的资源用 `ctx.effect(() => disposer)`。

⚠️ 多个异步 disposer **并发执行、无串行保证**——有顺序依赖的清理必须放进**同一个** `ctx.effect()` 里串行 await。

---

## 3. 强制契约

### 3.1 目录布局

一个仓库可以放多个插件（清单支持 monorepo 子包）。**子包放 `plugins/` 下**——这是清单 CI 会识别的目录之一（`packages/` · `plugins/` · `apps/` 与根包）：

```
dsh-plugins/                      # 本仓库
├── AGENTS.md                     # 本文件
├── package.json                  # 工作区根（private，可选的 pnpm workspace）
├── plugins/
│   ├── dsh-hello/
│   │   ├── package.json          # ← dsh.bundle 在这里
│   │   ├── cordis.patch.yml
│   │   ├── screenshots.json      # 可选，1–8 张
│   │   ├── src/index.ts
│   │   ├── lib/index.js          # 构建产物
│   │   └── README.md
│   └── dsh-world/
└── docs/
```

### 3.2 `package.json`（每个插件）

```jsonc
{
  "name": "dsh-hello",
  "version": "0.1.0",
  "description": "One-line, accurate description ending with a period.",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/<you>/<repo>.git" },
  "engines": { "node": ">=20" },

  "keywords": ["deepseek-harness", "dsh", "dsh-plugin"],   // dsh-plugin 必须有

  "peerDependencies": {                                     // ← R4
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0"
  },
  "devDependencies": {                                      // 镜像 peer，便于本地构建
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "0.1.5-rc.2"
  },

  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },            // ← R1，必须
    "client": { "platform": "web" }                         // 仅带浏览器 UI 时才写
  },

  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "publishConfig": { "access": "public" }
}
```

⚠️ 若从 GitHub 直装，**必须**额外提供自包含 `prepare` 脚本（pnpm 在 git 安装后跑它，且不能假设 monorepo 兄弟目录存在）：
```json
"scripts": { "build": "tsc -p tsconfig.json", "prepare": "npm run build" }
```

### 3.3 peerDependencies 的预发布陷阱（最容易静默出错）

node-semver 只有当范围里**某个**比较符与该版本的 `major.minor.patch` 元组完全一致、**且自身带预发布标签**时，才放行预发布版本。

```jsonc
// ❌ 看起来宽，实际静默排除所有 0.1.x-* 预发布 → 用户吃 ERESOLVE
"@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.2.0"
"@deepseek-ai/dsh-tools": ">=0.0.0-0 <0.2.0-0"          // 连"匹配一切"也不行

// ✅ 在 0.1.0 元组上带显式预发布分支
"@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0"
```

真实正确范例（`dshmarket`）：`"^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2"`

### 3.4 `cordis.patch.yml`

```yaml
# 顶层必须是数组
- insert:
    - id: dsh-hello            # 全局唯一的行 id
      name: dsh-hello          # ← 包名，让 Node 解析找到已安装代码
      # config: {...}          # 可选，插件的初始配置
```

**按 `id` 覆盖更早层的行时，必须重述该行需要的每一个 key**——patch 语义是**整行替换 `config`，不深合并**：

```yaml
- id: web
  config:
    searchProvider: ddg
    fetchProvider: http        # ← 不写这行就会被抹掉
```

### 3.5 接受用户配置（R6）

导出**同名** `Config` 类型 + Schemastery schema（**不能是普通对象**，Cordis 要求 Standard Schema）：

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string; maxRetries: number }
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
})

export function apply(ctx: Context, config: Config) { /* ... */ }
```

判定标准：**「`cordis.yml` 能不能在不改代码的前提下改掉它」**。不能 → 它就该是 Config 字段。
配置非法要在**加载时大声失败**（靠 schema 约束表达），不要拖到运行时。

---

## 4. 一个工具插件（可直接照抄）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

`defineTool` 已在本机 0.1.2-rc.1 核实存在（`@deepseek-ai/dsh-tools/lib/types/schema.d.ts`）。

---

## 5. 验证回路（**每次都要跑，不许跳**）

### 快回路 —— overlay，跑源码，不打包

```yaml
# dev/cordis.yml
- insert:
    - id: hello
      name: '/absolute/path/to/plugins/dsh-hello/src/index.ts'   # ← 必须绝对路径
```
```sh
dsh web --patch ./dev/cordis.yml
# 期望：启动日志出现 [dsh-hello] plugin loaded!
```

### 慢回路 —— 打成 bundle 装进一次性 profile

```sh
dsh plugin --profile demo add ./plugins/dsh-hello
dsh --profile demo --dump-config      # 期望：能看到 "# == dsh-hello" 这一层
dsh --profile demo
dsh plugin --profile demo remove dsh-hello
```

### 发布前检查单

- [ ] `dsh.bundle.patch` 存在且路径正确
- [ ] `cordis.patch.yml` 是数组，`name` 是包名
- [ ] `keywords` 含 `dsh-plugin`
- [ ] `@deepseek-ai/*` 全在 `peerDependencies`，且范围带预发布分支
- [ ] 无硬编码的可配置值
- [ ] 快回路 + 慢回路都实测通过
- [ ] `files` 含构建产物与 `cordis.patch.yml`
- [ ] README 描述与**实际行为**逐句一致（R8）
- [ ] `repository` 字段指向真实仓库

---

## 6. 禁止事项

| 禁止 | 原因 |
|---|---|
| 只声明 `dsh.client` 不声明 `dsh.bundle` | 无法安装，清单必拒 |
| 修改 profile 的 manifest | 那是用户侧，会被 `dsh plugin` 覆盖 |
| 硬编码超时/路径/开关 | 违反 R6，两个部署没法不同配置 |
| patch 里只写改动的 config key | 整行替换语义，会抹掉其他 key |
| 用 GitHub 直装作为首选分发 | 逼用户 `allowBuilds` = 授权安装期执行代码 |
| 描述夸大（"46 个工具"其实没有） | 清单会核代码，直接打回 |
| 做纯聚合包 | 清单不收录 |
| 改 agent loop | 新行为只挂文档化的扩展点 |
| 客户端插件硬编码文案/颜色 | 必须走 typed locale 字典 + `--dsw-*` token |
| waterfall 监听器不调 `next()` | 会短路整条链 |
| 未匹配的 patch target 当作成功 | 只在 stderr 报告，不致命，容易误判 |

---

## 7. 发布与收录

### 7.1 分发（R7：优先 npm）

```sh
dsh plugin --profile web add <npm-package>            # ① npm（首选）
dsh plugin --profile web add ./x-0.1.0.tgz            # ② tarball
dsh plugin --profile web add github:you/repo#<sha>    # ③ 下策，需 prepare + allowBuilds
```

### 7.2 收录进社区清单

- 清单站：<https://awesome-dsh-plugin.com>（实测 **4062** 个插件，23 分类，每日刷新）
- 数据仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- 市场插件：`dsh plugin --profile web add dshmarket`（其数据源就是上面的 `plugins.json`）

**投稿 = 加一个文件** `data/plugins/<owner>__<repo>.yml`（README 由脚本生成，**禁止手改**）：

```yaml
url: https://github.com/<you>/<repo>      # 必须与仓库完全一致
name: <you>/<repo>
category: tools                           # 见下方取值
description:
  en: One-line description ending with a period.
  zh: 一句话描述，以句号结尾。               # 可选，维护者会补
# tarball: https://github.com/<you>/<repo>/releases/download/v1.2.0/x-1.2.0.tgz   # 可选
```

⚠️ 描述含 `: `（冒号+空格）**必须加引号**，否则 YAML 解析失败。
⚠️ monorepo 子包：`url` 指到子目录，`name` 用 `<owner>/<repo>#<subname>`，文件名 `<owner>__<repo>--plugins-<name>.yml`。

**category 取值**：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`
**主题/皮肤必须放 `theme`**（会自动进市场的 Themes Tab），不要放 `ui`。

**硬性门槛**：`dsh.bundle` 声明 · 有真实可用代码 · 仓库创建满 1 天 · 活跃维护 · 加了 `dsh-plugin` topic · 描述属实 · 分类贴切 · 非纯聚合包 · **一个 PR 最多 3 条**。

**可选 `screenshots.json`**（放 `package.json` 旁边，1–8 张，相对路径不得跳出插件目录；绝对 URL 必须是 GitHub 托管的 https）。

---

## 8. 本机环境事实

| 项 | 值 |
|---|---|
| DSH 实现 checkout | `C:\Users\BYC10\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` |
| 核心包版本 | `0.1.2-rc.1`（cordis `4.0.2`） |
| npm latest | `0.1.5-rc.2`；alpha `0.1.6-alpha.2` |
| `dsh` 启动器 | `C:\Users\BYC10\AppData\Roaming\npm\dsh.cmd` |
| DSH_HOME | `%USERPROFILE%\.dsh` |
| web profile | `$DSH_HOME\profiles\web`（已装 20 个 bundle） |
| pnpm | 已装（`dsh plugin` 是 pnpm 转发器；缺它直接退出 127） |

⚠️ **本机核心落后 npm latest 三个 rc**。动手前先 `npm i -g @deepseek-ai/dsh@latest`，否则测的是旧行为；`devDependencies` 也应跟上。

⚠️ **API 是 pre-stable**：上游 README 明写 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"，`AGENTS.md` 写 "Public APIs are pre-stable; update every consumer"。**插件必须把版本约束写进 peerDependencies，并准备随上游更新。**

---

## 9. 故障排查

| 症状 | 原因 / 处置 |
|---|---|
| 插件装了但没生效 | `dsh --profile X --dump-config` 看有没有你的层；没有 → 多半是缺 `dsh.bundle`（会打印一次 warning） |
| 装/卸 bundle 后没变化 | **bundle 成员变更需要重启该 profile**（运行中的 profile 保持启动时的 bundle 集合） |
| 改了 profile 的 patch 没生效 | profile/home 的 `cordis.patch.yml` 编辑走热重载，但仍建议重启确认 |
| 启动直接挂掉 | **启动是 all-or-nothing**，一个插件失败停整个进程。日志在 `$DSH_HOME\logs\startup-<ts>-<uuid>.log`，**含原始错误、可能带配置或凭据值且不脱敏** |
| 用户装的时候 `ERESOLVE` | peer 范围没带预发布分支（§3.3） |
| `pnpm not found on PATH` | 装 pnpm |
| GitHub 直装失败、提示 allowBuilds | pnpm ≥10 拦截构建脚本，按提示往 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: { <pkg>: true }` |
| 配置被"吃掉"了 | patch 是整行替换，覆盖时漏写了 key |

---

## 10. 安全与责任（必读）

### 10.1 插件不受那三档权限约束——插件就是宿主本身

DSH 的三档文件权限（`read-only` / `workspace-write` / `danger-full-access`）**只审查「模型发起的工具请求」，不约束插件代码**。

雷锋网 2026-09-01 的实测（探针插件按正常流程安装，三档各跑九项试探）：**9/9 在三档权限下全部成功**——包括在最严的 `read-only` 档下列出 `~/.ssh/`、从环境变量读到 API key、往 `/tmp` 写文件并读回、连上外网。
<https://finance.sina.com.cn/tech/roll/2026-09-01/doc-iniqihzt8129217.shtml>

原因：**"插件不是访客，插件是我同事，所以保安不会查他。"** 那三档是给"访客"（模型请求）用的。

官方立场也很明确：设计笔记写过「安全与权限不是设计目标」；`packages/extensions/tool-cordis/README.md` 自称「沙箱不是安全边界，请把这套工具当作 bash 权限对待」。

**对作者的含义（硬约束）：**
- 你的插件在用户机器上 = **该用户账号的全部权限**：读 SSH 私钥、云凭据、其他项目源码，任意写文件，连外网。**安装即授权，不需要用户同意任何东西。**
- 所以：**不做任何超出声明功能的事**。任何文件/网络/凭据访问都必须在 README 里明说。
- `prepare` 脚本尤其敏感（安装期执行）——**这是首选 npm / tarball 而非 GitHub 直装的另一个理由**（R7）。
- 顺手改配置是很危险的：已知实例——某终端皮肤插件会改写沙箱策略并在 Windows 上强制拉到 `danger-full-access`（作者有注释说明理由）；某"增加中间权限档"的插件实际只是加了个审批预设，其分类器提示词写着 `Default to approve`，**净效果是减少了一层复核**。

**对使用者的含义：** 装之前读源码；**清单收录 ≠ 安全审查**（清单 README 自己也这么写）。

### 10.2 装插件会让 prompt cache 整段失效

工具说明书排在前缀里。装一个插件 = 往前缀插入若干段新说明 → **从变动处往后全部作废**。首轮变慢、变贵，且工具越多模型越容易选错工具（官方做 Code Mode 就是为了治它）。

**整个生态里没有一处提示这件事**——这是公认的生态真空，也是潜在的产品机会。

**对作者的含义：** 尽量精简 `description` 与参数说明；工具数量宁少勿多；能合并的工具就合并。

### 10.3 插件互相冲突很常见

实测把"按仓库去重后下载量前十"的插件装进同一配置，**直接起不来**，冲突涉及第 2、3、6 名；必须禁掉其中两个才行。典型原因：某 UI 全家桶的依赖里自带一个侧边栏组件，你再单独装一个侧边栏插件，两者抢同一个界面路径。

**对作者的含义：** 若你的插件占用界面路径 / slot / 服务名，**必须在 README 里声明冲突面**。上游已把"后面的层按行整行覆盖、不深合并"的语义写清楚，但**没有任何工具去检测冲突**。

### 10.4 清单名 ≠ npm 名，没有映射

发现靠 GitHub 标签与社区清单，安装靠 npm，**中间没有映射，也没有谁负责对齐**。实测抽 12 个"未发正式包"的清单条目去 npm 查同名，5 个存在同名包，**逐个比对后全是另一个作者的另一个项目**。

**对作者的含义：** 发 npm 时务必让 `repository` 字段指回你的仓库（清单也是靠这个字段做关联的）；不要指望名字唯一。

---

## 11. 参考文档

**可复用 skill（跨项目）**
- `dsh-plugin-authoring` —— 已安装于 `$DSH_HOME/skills/dsh-plugin-authoring/SKILL.md`。
  任何提到 DSH 插件开发的会话都会自动加载它。**本文件是该仓库的具体化，skill 是通用版**；两者冲突时以本文件为准。

**本仓库内**
- `DSH-PLUGIN-CONTRIBUTION-GUIDE.md` —— 完整实操指南（契约、扩展点、客户端插件、发布收录）
- `dsh-plugin-landscape.md` —— 生态调研（4062 个插件的分布、已有覆盖、空白）
- `awesome-dsh-plugins-condensed.txt` —— 插件清单精简版

**上游权威文档**
| 主题 | 链接 |
|---|---|
| 贡献政策（说明不收 PR） | <https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.zh.md> |
| 第一个插件 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md> |
| 构建工具 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md> |
| 插件配置 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md> |
| **打包与安装（必读）** | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md> |
| **扩展点总览（feature→机制）** | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md> |
| 工具编写权威参考 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md> |
| CLI 权威参考 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md> |
| 浏览器侧插件硬规则 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/AGENTS.md> |
| 插件生命周期 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md> |
| **清单收录规则** | <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md> |
