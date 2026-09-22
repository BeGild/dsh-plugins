# 为 DeepSeek Harness 贡献插件：实操指南

> 调研时间 2026-09-21。所有结论均带来源链接；未能证实的一律标注 UNVERIFIED。
> 本机实测环境：DSH 实现 checkout = `C:\Users\BYC10\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`，核心包版本 **0.1.2-rc.1**（cordis 4.0.2）。

---

## 0. 最重要的一条：上游不收外部 PR

这是整个计划的地基，先说清楚，否则方向会错。

上游仓库 `deepseek-ai/deepseek-harness` 的 **Issues 和 PR 功能是关闭的**。GitHub API 实测返回：

```
"has_issues": false,
"has_pull_requests": false,
"has_discussions": true,
"open_issues_count": 0
```

来源：<https://api.github.com/search/repositories?q=topic:dsh-plugin>

`CONTRIBUTING.zh.md` 也明说了：

> DeepSeek Harness 仍处于早期阶段，并在积极开发中。很抱歉，我们目前无法接受外部 PR（Pull Request）。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/CONTRIBUTING.zh.md>

**所以"给这个项目贡献插件"的正确含义是：**

| 你想要的 | 实际该做的 | 能否做到 |
|---|---|---|
| 往 `packages/` 里加代码、提 PR | — | ❌ 上游 PR 关闭 |
| 报 bug / 提需求 | 上游 GitHub **Discussions** | ✅ |
| 写插件给别人用 | **自己开仓库 + 发 npm + 收录进 awesome 列表** | ✅ 主路径 |
| 让插件被搜到 | 给仓库加 `dsh-plugin` topic + 提 PR 到 awesome 列表 | ✅ |

上游明确把"插件生态"当作替代贡献路径：

> 为生态系统作出贡献：创建令你感兴趣的插件，并分享给其他人：为你的 GitHub 项目添加 `dsh-plugin` 话题，让其他人更容易找到你的插件。

**真正需要提 PR 的仓库是 `awesome-dsh-plugin/awesome-dsh-plugin`（插件清单），不是上游。**

---

## 1. 插件到底是什么

DSH 的哲学是 "Everything is a Plugin"（仓库 description 原文）。插件 = 一个 **Cordis plugin**，即导出了 `apply(ctx)` 的模块：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // 在这里通过 ctx 注册能力
}
```

三种形态（按需选用，多数情况函数形态足够）：

- **函数形态**：`export function apply(ctx)` — 最常用
- **对象形态**：`export default { name, inject, apply(ctx) {} }`
- **类形态**：`export default class extends Service` — 当你的插件**对外提供服务**时用

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/index.md>

两个关键机制：

1. **`inject` 声明依赖**：`export const inject = ['tools']` — 框架会等所需服务就绪后才调用 `apply`。
2. **自动清理**：通过 `ctx` 注册的一切（事件、工具、定时器）在插件卸载时自动清理，不用手写 `removeListener`。需要显式清理的资源用 `ctx.effect(() => disposer)`。

---

## 2. 两个 manifest：bundle 与 profile（最容易搞混的地方）

官方原文：**"A bundle is what you author and distribute; a profile is what a user boots with. Nothing is both."**

### bundle —— 你写的、你分发的

```jsonc
// package.json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }   // ← 必须
}
```

```yaml
# cordis.patch.yml —— 顶层是 YAML 数组
- insert:
    - id: hello
      name: dsh-hello-plugin
```

### profile —— 用户启动用的

`$DSH_HOME/profiles/<name>/`，由 `dsh plugin` 命令自动维护，**你不需要手写**。它记录 `dsh.profile.bundles` 有序列表。

### 安装

```sh
dsh plugin --profile web add ./hello-plugin     # 本地目录
dsh plugin --profile web add dsh-hello-plugin   # npm 包
dsh plugin --profile web add github:you/repo    # GitHub 仓库
```

`dsh plugin` 本质是 **pnpm 的转发器**：在 profile 目录里跑 pnpm，然后按"已安装状态"把声明了 `dsh.bundle` 的依赖追加进 `dsh.profile.bundles`。

验证层是否生效（不用启动）：

```sh
dsh --profile demo --dump-config   # 应能看到 "# == dsh-hello-plugin" 这一层
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.md>

### 配置层叠加顺序（后面的赢）

1. profile 的 `dsh.profile.bundles` 里每个 bundle 的 patch（按列表顺序）
2. profile 自己的 `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`
4. 每个 `--patch <path>` overlay（按 argv 顺序）

⚠️ **patch 是整行替换，不是深合并**：你覆盖某行的 `config` 时必须把该行需要的**所有**键都重写一遍，不能只写改动的那一个。

---

## 3. 最小可安装插件（照抄官方）

```
hello-plugin/
├── package.json
├── cordis.patch.yml
└── index.js
```

```js
// index.js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

加一个工具（`defineTool` 来自 `@deepseek-ai/dsh-tools`，**已确认存在于本机 0.1.2-rc.1**）：

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

`defineTool` 已在本机验证存在：

```
...\@deepseek-ai\dsh-tools\lib\types\schema.d.ts:239:
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
```

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/tool.md>

### 接受用户配置

导出同名 `Config` 类型 + Schemastery schema：

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string; maxRetries: number }
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
})

export function apply(ctx: Context, config: Config) { /* ... */ }
```

⚠️ 官方明确要求：**"任何两个部署可能想设成不同值的量，都必须是配置字段"**，不要硬编码。

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/config.md>

---

## 4. 开发回路：两种，先快后慢

### 快回路 —— `--patch` overlay，直接跑源码，无需打包

```yaml
# scratch-plugin/cordis.yml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

⚠️ **插件路径必须是绝对路径**（patch 文件只贡献配置，不改变 loader 解析模块路径的基准目录）。

### 慢回路 —— 打成 bundle 装进 profile

见第 2 节。适合验证"用户视角的安装体验"。

---

## 5. 分发：三条路，选一条

| 方式 | 命令 | 代价 |
|---|---|---|
| **发 npm**（推荐） | `dsh plugin add <pkg>` | 需构建 `lib/`，用户无额外步骤 |
| **发 tarball** | `dsh plugin add ./x.tgz` | `pnpm pack` 产物，用户无额外步骤 |
| **GitHub 直装** | `dsh plugin add github:you/repo` | ⚠️ 用户必须手工放行构建 |

### GitHub 直装的坑（重要）

从 git 装拿到的是**源码不是构建产物**：不会跑你的 `build`，TypeScript 包会因为缺 `lib/` 而加载失败。两边都要做事：

- **作者**：提供 `prepare` 脚本（pnpm 在 git 安装后会跑它），必须自包含，不能依赖 monorepo 兄弟目录。
- **用户**：pnpm ≥10 默认**拒绝**运行 git 依赖的 `prepare`，第一次 `add` 会失败。要在 profile 的 `pnpm-workspace.yaml` 里放行：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

官方对这一步的定性值得原样引用：**"Treat that allowance as permission to execute the package's code on your machine at install time, outside any sandbox the agent runs under."** 并且建议 pin commit sha：`github:you/repo#<sha>`。

**结论：想让用户装得省心，就发 npm 或发 tarball。**

---

## 6. 被收录进 awesome 列表（这才是你要提的 PR）

- 列表站：<https://awesome-dsh-plugin.com>（实测 `plugins.json` 里 **4062** 个插件，updated 2026-09-20）
- 数据仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- 市场插件：`dsh plugin --profile web add dshmarket`（GUI 里一键装）
- 让 agent 帮你找：`dsh plugin --profile web add dsh-find-plugin`

### 投稿方式：一个 PR 只加一个 YAML 文件

文件名 `data/plugins/<owner>__<repo>.yml`：

```yaml
url: https://github.com/owner/repo        # 必须与仓库完全一致
name: owner/repo
category: ui
description:
  en: One-line description ending with a period.
  zh: 一句话描述，以句号结尾。   # 可选，维护者会补
```

⚠️ **描述里含 `: `（冒号+空格）必须加引号**，否则 YAML 解析失败。

⚠️ **不要手工编辑 README** —— 两个 README 由 `data/plugins/*.yml` 生成。

### 硬性门槛（CI 检查）

1. **一个 PR 最多 3 条**（最先检查）
2. **`package.json` 必须声明 `dsh.bundle`** ← **最常见的被拒原因：只声明了 `dsh.client`，那样根本无法安装**
3. **仓库创建满 1 天**
4. `awesome-lint` + 站点构建

### 维护者人工评审会看的

1. **代码是否与描述一致** —— 包括描述里的数字和 API 名。"写 46 个工具就该真有 46 个工具"，**夸大是让好插件被打回的主因**
2. 分类是否合理（不会因分类被打回，维护者直接改）
3. 是否真实可用代码（占位仓库、纯 README 不收）
4. 是否与已有条目重复（平局时先来者留位，但"规则不是先来后到，规则是谁更好"）
5. 源码是否可疑（混淆代码、凭据外传、异常安装期行为）
6. **PR 是否动了无关条目**
7. **纯聚合包不收录** —— 内容只有一份依赖清单的 bundle 不占一行，"收插件，不收聚合包"
8. 聚合包的依赖必须指向**原作者**仓库/npm，不能重新上传别人的插件再依赖副本

### peerDependencies 的预发布陷阱（很隐蔽，务必看）

⚠️ **不带显式预发布分支的 peer 范围会静默排除 harness 的所有预发布构建。**

node-semver 只有当范围里**某个**比较符与该版本的 `major.minor.patch` 元组完全一致、**且自身也带预发布标签**时，才会放行预发布版本。

```jsonc
// ❌ 看起来宽，实际静默排除所有 0.1.0-* 预发布
"peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.2.0" }

// ✅ 在 0.1.0 元组上带显式预发布分支
"peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0" }
```

本机 0.1.2-rc.1 落在第二个分支内 ✅。

真实插件的写法可参考 `dshmarket`（本机已装）：

```json
"@deepseek-ai/dsh-settings": "^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2"
```

另外官方建议：**官方 `@deepseek-ai/*` 包用 `peerDependencies` 声明，不要用 `dependencies`。**

### 可选但推荐

- **发 npm** → 市场能按下载量排序（**不影响收录**）。包的 `repository` 字段必须指回被收录的那个仓库。
- **`screenshots.json`**（放在 `package.json` 旁边，1–8 张）：让市场展示 App Store 风格截图。相对路径、不能跳出插件目录；绝对 URL 必须是 GitHub 托管的 https。
- 主题/皮肤类**必须放 `theme` 分类**（会自动进 dsh-market 的主题 Tab），不要放 `ui`。

来源：<https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/contributing.md>

---

## 7. 本机环境实测事实

| 项 | 值 |
|---|---|
| DSH 实现 checkout | `C:\Users\BYC10\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` |
| 核心包版本 | `0.1.2-rc.1`（dsh-base / dsh-tools / dsh-settings / dsh-app-boot 均为此版本） |
| cordis | `4.0.2` |
| npm latest | `0.1.5-rc.2`；alpha `0.1.6-alpha.2` |
| DSH_HOME | `%USERPROFILE%\.dsh` |
| web profile | `$DSH_HOME\profiles\web`，已装 20 个 bundle（含 dshmarket / dsh-orchestrator / dsh-free-search …） |
| `dsh` 启动器 | `C:\Users\BYC10\AppData\Roaming\npm\dsh.cmd` |

**注意两点：**

1. **本机 0.1.2-rc.1 落后 npm latest 三个 rc**。写插件前建议先 `npm i -g @deepseek-ai/dsh@latest`，否则你测的是旧行为；且 peer 范围要覆盖预发布元组（见上）。
2. **`dsh plugin` 依赖 pnpm**：`dsh plugin` 是 pnpm 转发器，PATH 里没有 pnpm 时会直接报 `pnpm not found on PATH — install pnpm to manage profile plugins`（退出码 127）。

> 诚实声明：本次调研的沙箱**无法执行 node / pnpm / dsh**（shim 被拦截），所以第 3 节的代码是**照抄官方文档**并经类型定义核对，但**我没有在本机实际跑起来验证**。请你在自己的 shell 里跑一遍快回路确认。

---

## 8. 建议的第一步（最小闭环）

1. **确认版本**：`npm i -g @deepseek-ai/dsh@latest`；`dsh --version`
2. **建仓库**：`github.com/<you>/dsh-<name>`，加 `dsh-plugin` topic
3. **搭骨架**：`package.json`（含 `dsh.bundle.patch`）+ `cordis.patch.yml` + `index.js`
4. **快回路验证**：`dsh web --patch ./dev/cordis.yml`，确认 `[hello-plugin] plugin loaded!` 打印出来
5. **慢回路验证**：`dsh plugin --profile demo add ./hello-plugin` 然后 `dsh --profile demo --dump-config` 看到自己那一层
6. **发布**：`pnpm publish`（npm 包）或 `pnpm pack`（tarball）
7. **投稿**：向 `awesome-dsh-plugin/awesome-dsh-plugin` 提一个 PR，只加 `data/plugins/<owner>__<repo>.yml`

---

## 9. 能挂哪些扩展点（决定你的插件做得到什么）

**最有价值的一张表在 `docs/cookbook/extension-cookbook.md`（feature → 机制映射）**，动手前先读它。

Host 侧（Node）常用服务与钩子：

| 想做的事 | 用什么 |
|---|---|
| 加一个工具 | `ctx.tools.register(defineTool({...}))` |
| 拦/改工具调用（权限门、超时、重试、指标） | `tools/pre-execute`（可返回 allow/deny/**ask**）、`tools/execute`、`tools/post-execute`、`tools/result` waterfall |
| 单调最终拒绝 | `ctx.tools.guard()` |
| 作用域工具过滤（展示/查找/执行三者一致） | `ctx.tools.restrict()` |
| 长任务 | `ctx.jobs.start({ kind, label, owner: exec.agent, run })` |
| 每轮/每步介入 | `agent/pre-step`、`agent/request`、`agent/turn-stopping`、`turn/end` |
| 给会话追加持久上下文 | `agent.followup()` / `agent.steer()` / `agent.inject()`（`inject` 只影响**下一个**请求，**不唤醒**） |
| 改系统提示 | `ctx.systemPrompt.section()`、`system-prompt/assemble` |
| 接入模型厂商 | `@deepseek-ai/dsh-llm` 的 `LlmAdapter` + `registerAdapter` |
| 加斜杠命令 / 设置卡片 | `packages/interaction/`、`docs/cookbook/adding-a-settings-card.md` |
| 接 MCP | 每个 server 一个插件：discover → `ctx.tools.register()` |

⚠️ **waterfall 监听器必须调 `next()`** 才能委托，不调即短路整条链。

⚠️ **改 agent loop 是禁止的**：新行为只挂文档化的扩展点。

⚠️ **模型可见 ⟺ 已记录**：任何进入模型请求的东西都必须能从 session log 重建；新的模型可见输入**必须**新增 session event。

⚠️ **启动是 all-or-nothing**：任何一个插件加载失败会停掉整个进程。失败日志在 `$DSH_HOME/logs/startup-<timestamp>-<uuid>.log`，**含原始错误、可能带配置或凭据值且不脱敏**。

---

## 10. 客户端（浏览器）插件：额外的硬约束

只有需要改 Web UI 时才走这条路。`package.json` 必须**同时**有：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // ← 仍然必须，否则不可安装
  "client": {
    "platform": "web",                            // ← 必填
    "inject": ["@deepseek-ai/dsh-client-locale"]  // 仅信息性
  }
}
```

并且**必须提供 `./client` export**，否则扫描直接抛错。

构建产物是 **closure-factory artifact**（不是普通 ESM）：

```js
window.__ModuleLoader__.load({ id: "your-plugin", factory: (require) => { /* ... */ return module.exports; } });
```

**最佳照抄对象**：`dshmarket` 的 `tsdown.config.ts` —— 它明确注释为 "mirroring the DeepSeek Harness client preset for an external package"，含 `format: 'cjs'`、banner/footer 注入、`external: ['react', ...]`、CSS Modules 走 lightningcss。

几条会咬人的运行时契约（`packages/client/AGENTS.md`）：

- 组件**永不接触 `ctx`**；业务组件零订阅机器（不用 `useSyncExternalStore`）
- store 必须是导出的 `createXXXStore()` 工厂，**禁止模块级单例**
- 跨包**只能**用 `import type` 共享声明，禁止运行时 import 另一个功能插件的值
- **产品文案必须走 typed locale 字典 + `t`**（硬编码文案会被 gate 拒绝）
- 样式用 CSS Modules + `--dsw-*` 语义 token，**禁止字面颜色、组件库、Tailwind**
- 不要在自己的 manifest 里重复基线 externals（`react`、`cordis`、`ui-primitives`…）

**开发/HMR**：客户端插件 HMR 接收器总是挂载，但要真正热更需**另起 watcher**：`pnpm run dev:web`（且它依赖先跑过一次完整 `pnpm run build` 的产物树）。客户端插件改动**必须重建 bundle** 才会被 live server 探到。

---

## 11. 关键文档索引

| 主题 | 链接 |
|---|---|
| 贡献政策（中文，说明不收 PR） | <https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.zh.md> |
| 第一个插件 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md> |
| 构建工具 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md> |
| 插件配置 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md> |
| 打包与安装 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md> |
| 工具 DSL 完整参考 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md> |
| 能力分层实践 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/index.md> |
| 插件生命周期 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md> |
| cordis 入门 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md> |
| **扩展点总览（feature→机制，动手前先读）** | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md> |
| 工具编写权威参考 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md> |
| **CLI 权威参考（层优先级 / profile / HMR）** | <https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md> |
| 浏览器侧插件硬规则 | <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/AGENTS.md> |
| `dsh.client` 扫描与 `__DSH_BOOT__` | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.md> |
| 插件清单收录规则 | <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md> |
| 插件市场站 | <https://awesome-dsh-plugin.com> |
| 官方上游 | <https://github.com/deepseek-ai/deepseek-harness> |
