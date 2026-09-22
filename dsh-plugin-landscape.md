# DeepSeek Harness (DSH) 第三方插件生态调研报告

数据采集时间：2026-09-21（GitHub / npm 快照）。
所有数字均标注来源 URL；未能确认的一律写 UNVERIFIED。

---

## 1. 插件如何被发现与安装

### 1.1 安装命令形态（已证实）

```sh
dsh plugin add <npm-name>                    # 通用形态
dsh plugin --profile web add <npm-name>      # 指定 profile（用户当前用的就是 web profile）
```

来源：<https://raw.githubusercontent.com/dsh-market/dsh-market/main/README.md>（`dsh plugin --profile web add dshmarket`）、
<https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md>（"installable via `dsh plugin add`"）。

### 1.2 可安装的硬性条件（关键！）

仓库 `package.json` 必须声明 **`dsh.bundle`** manifest：

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },  // ← 必须
    "client": { "platform": "web" }               // 仅当带浏览器 UI
  }
}
```

并配一个 `cordis.patch.yml`：

```yaml
- insert:
    - id: your-plugin-id
      name: your-package-name
```

⚠️ 精确表述（两个来源略有差异，都列出）：
- 精选列表口径：**只声明 `dsh.client` 无法安装**，这是最常见的被拒原因。
  <https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/contributing.md>
- 官方文档口径（更精确）：*"A package without the `dsh.bundle` declaration still installs, but only as a
  plain dependency: `dsh plugin` prints a warning and activates no layer."*
  <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.md>

官方文档给出的完整安装形态（`docs/user/develop/basic/publish.md`）：

```sh
dsh plugin --profile demo add ./hello-plugin              # 本地目录
dsh plugin --profile demo add github:you/hello-plugin     # GitHub（需作者提供 prepare 脚本 + 用户 allowBuilds）
dsh plugin add ./hello-plugin-0.1.0.tgz                   # tarball
dsh plugin add your-package                               # npm 包
```

`dsh plugin --profile <name> <args...>` 实际是**转发给该 profile 目录下的 pnpm**。
配置层叠加顺序：bundle patches（按列表顺序）→ profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlay。
pnpm ≥10 默认拦截构建脚本，从 GitHub 源码安装需要用户在 profile 的 `pnpm-workspace.yaml` 里显式 `allowBuilds`。

其他要求：仓库须有真实可用代码（占位/纯 README 不收）、仓库创建满 1 天、项目在维护中、给仓库加
`dsh-plugin` topic、官方 `@deepseek-ai/*` 包应声明为 `peerDependencies`（且预发布版本要写显式 `||` 分支）。

### 1.3 官方发现机制

DSH 主仓库 README 明确写着：

> Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md>

同一 README 还指出反馈渠道是 **GitHub Discussions**（不是 Issues）与 Discord 社区。
**实测确认主仓库 `has_issues: false`、`open_issues_count: 0`** —— 上游不接受 issue，需求要走 Discussions。
来源：<https://api.github.com/repos/deepseek-ai/deepseek-harness>

### 1.4 是否存在中心化注册表 / 市场？—— 存在，而且是多层

| 角色 | 名称 | 证据 |
|---|---|---|
| **权威精选注册表** | `awesome-dsh-plugin`（16499★，CC0） | <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>；数据源为 `data/plugins/<owner>__<repo>.yml`，一插件一文件 |
| 机器可读目录 | `awesome-dsh-plugin.com/plugins.json` + `count.json` | count.json 报 **4062** 条（<https://awesome-dsh-plugin.com/count.json>） |
| npm 目录包 | `dsh-plugin-catalog`（4062 entries，exports `./plugins.json`） | <https://registry.npmjs.org/dsh-plugin-catalog/latest> |
| 更新日志数据 | `dsh-plugin-updates`（4060 entries） | 同仓库，见 npm search 结果 |
| **应用内市场** | `dshmarket`（4314★，93668 周下载） | <https://github.com/dsh-market/dsh-market>、<https://api.npmjs.org/downloads/point/last-week/dshmarket> |
| 市场网站 | <https://dshmarket.com> | 同上 |
| 第三方目录站 | DSH Get（dshget.com），数据快照 `bobby-sheng/dshget-data` | dsh-market README "Friends" 段 |
| 竞品市场 | `dsh-plugin` npm（自称 "9000+ curated"）、`dshhub-market`（口令市场）、`@noob-stupid/dsh-plugin-console`（多源市场） | npm search 结果，见 §2 |
| 生态雷达 | `AdamPlatin123/dsh-plugin-radar`（1464★，"21k+ candidates"） | <https://github.com/AdamPlatin123/dsh-plugin-radar> |
| agent 内搜索 | `dsh-find-plugin`（5326 周下载） | <https://github.com/awesome-dsh-plugin/dsh-find-plugin> |

**重要机制**：dsh-market 的安装源**被限制在 awesome-dsh-plugin 精选注册表内**，其它来源一律拒绝
（"Installs are restricted to sources listed in the curated awesome-dsh-plugin registry"）。所以
**想被用户装到，就得先进入 awesome list** —— 这是唯一的关键入口。

### 1.5 进入精选列表的成本（对"第一次贡献"极其友好）

一个 PR **只加一个文件** `data/plugins/<owner>__<repo>.yml`：

```yaml
url: https://github.com/owner/repo
name: owner/repo
category: tools        # 23 个合法分类之一
description:
  en: One-line description ending with a period.
```

分类取值：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill
workflow git notify dev security remote market fun`。
每个 PR 最多 3 条；README 由脚本生成，**不要手改**。
来源：<https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/contributing.md>

### 1.6 生态规模（三个口径不同，引用时需区分）

- 精选目录：**4062** 条（<https://awesome-dsh-plugin.com/count.json>，2026-09-21）
- dsh-market README 自称：**2300+** plugins（<https://github.com/dsh-market/dsh-market>）
- GitHub `topic:dsh-plugin` 仓库搜索 total_count：**15682**（<https://api.github.com/search/repositories?q=topic:dsh-plugin>）
- 第三方雷达自称候选 **21k+**（dsh-plugin-radar，UNVERIFIED 精确度）

---

## 2. 值得关注的第三方插件（npm 名已逐个对 registry 校验）

周下载 = npm registry search/downloads API（2026-09-21 / 周区间 2026-09-14..20）；
★ = awesome-dsh-plugin `data/stars.json` 快照，**checkedAt 2026-08-19（约一个月前，偏低）**。

| npm 包 | 仓库 | 作用 | 周下载 | ★ | 最近发布 |
|---|---|---|---|---|---|
| `dshmarket` | dsh-market/dsh-market | 应用内插件市场（浏览/搜索/一键装/主题） | 93668 | 4314 | 2026-09-21 |
| `dsh-plugin-model-proxy` | UNVERIFIED（npm 无 repository 字段） | 按模型走 http/socks5 代理 | 53799 | – | 2026-09-08 |
| `dsh-context` | bowenliang123/dsh-context | 上下文管理 | 22675 | 416 | – |
| `@michengai/dsh-archive-manager` | MichengAI/dsh-archive-manager | 归档会话管理 | 23473 | 3 | 2026-09-21 |
| `@michengai/dsh-skills-manager` | MichengAI/dsh-skills-manager | Skills 统一加载与安全管理 | 22571 | 8 | 2026-09-21 |
| `dsh-cost-meter` | Han-1413141/dsh-cost-meter | 会话费用/额度/峰谷计价 | 17581 | – | 2026-09-18 |
| `dsh-whale-widget` | MeteorNOX/DeepSeek-Balance-Whale-Widget | 余额小鲸鱼挂件 | 16592 | – | 2026-09-19 |
| `dsh-mnemosyne` | UNVERIFIED | 记忆类 | 12845 | – | 2026-09-13 |
| `dsh-server-deck` | UNVERIFIED | 服务面板 | 11826 | – | 2026-09-11 |
| `@nanmicoder/dsh-agent-teams` | NanmiCoder/dsh-agent-teams | 多智能体团队协作 + 树状监控 | 10801 | 573 | 2026-09-17 |
| `@xmanrui/dsh-im` | xmanrui/dsh-im | 11 种 IM 渠道接入（飞书/微信/钉钉/Slack…） | 8994 | – | 2026-09-20 |
| `dsh-univer-office` | dream-num/dsh-univer-office | Univer 表格/文档内联预览 | 8757 | – | 2026-09-17 |
| `@liustack/modsearch` | liustack/modsearch | 免 key 网页搜索/抓取 | 7360 | – | 2026-09-15 |
| `dsh-pet` | PC2005-cloud/dsh-pet | 桌宠 | 7174 | 163 | 2026-09-16 |
| `dsh-dream-skin` | RevolutionLA/dsh-dream-skin | 换肤/主题包 | 7070 | – | 2026-09-16 |
| `dsh-mnemon` | omdsh-dev/dsh-mnemon | 三层可组合记忆控制面 | 6745 | 109 | 2026-09-19 |
| `dsh-pocket` | shaobeichen/dsh-pocket | 手机扫码远程访问 | 5653 | – | 2026-09-10 |
| `dsh-find-plugin` | awesome-dsh-plugin/dsh-find-plugin | agent 内插件搜索（GitHub topic + 星数排序） | 5326 | 58 | 2026-08-19 |
| `dsh-free-search` | DDDMUC/dsh-free-search | 多引擎搜索（免 key） | 4994 | – | 2026-09-17 |
| `@tt-a1i/archify-dsh` | tt-a1i/archify | 架构图/流程图生成 | 4337 | 68885（archify 主仓） | 2026-08-14 |
| `@furongjun1999/dsh-memory` | FuRongJun-1999/dsh-memory | 白盒记忆/认知图 | 4098 | – | 2026-09-20 |
| `dsh-chat-import` | Nwflower/dsh-chat-import | 导入外部聊天记录为会话 | 3949 | 71 | 2026-09-20 |
| `@mrrisega/dsh-remote` | mrRisega/dsh-remote | 手机远程控制（PWA 级） | 3657 | – | 2026-09-19 |
| `@morlay/session-rdb` | morlay/session-rdb | RDB 持久化会话后端 + rewind/fork | 3415 | – | 2026-09-14 |
| `dsh-codex-subscription` | UNVERIFIED | Codex 订阅接入 | 3425 | – | 2026-09-16 |
| `dsh-config-manager` | xiajiajun516/dsh-config-manager | 配置备份/迁移/同步 | 3422 | – | 2026-09-18 |
| `@kenz1117/dsh-ui-usage-billing` | kenz1117/dsh-ui-usage-billing | 用量计费仪表盘 | 3185 | – | 2026-09-20 |
| `@wxg-prc-cpg/browser-skill-dsh-plugin` | Tencent/BrowserSkill | 腾讯 BrowserSkill 浏览器自动化工具 | 3111 | – | 2026-09-17 |
| `dsh-coding-subscription-oauth` | lninghaha/dsh-coding-subscription-oauth | Grok/Codex/Kimi/Claude 订阅 OAuth | 3054 | – | 2026-09-15 |
| `dsh-plugin` | dshplugin/dsh-plugin-hub | 社区市场（自称 9000+） | 2846 | – | 2026-09-18 |
| `@aiwayds/dsh-tui-pi` | fan56/dsh-tui-pi | pi 风格终端 UI | 2795 | – | 2026-09-17 |
| `dsh-image-gen` | UNVERIFIED | 图像生成 | 2662 | – | 2026-09-20 |
| `dsh-builtin-browser` | UNVERIFIED | 内置浏览器 | 2418 | – | 2026-09-16 |
| `dsh-vscode-mode` | Lenonss/DSH_VsCodeMode | 类 VSCode 编码体验（Monaco/LSP/SVN） | 2406 | – | 2026-09-18 |
| `dsh-plugin-catalog` | awesome-dsh-plugin/awesome-dsh-plugin | 目录数据包（4062 条） | 2385 | – | 2026-09-21 |
| `dsh-mobile` | saya-ch/dsh-mobile | 移动端适配与安全访问 | 2167 | – | 2026-09-20 |
| `dsh-tiddlywiki` | UNVERIFIED | TiddlyWiki 知识库 | 2140 | – | 2026-09-21 |
| `stratagate-dsh` | diqierjia/StrataGate-AgentMemory | 六层时间衰减记忆 | 2017 | – | 2026-09-21 |
| `dsh-remote` | flymysql/dsh-remote | SSH 远程工作区 + 20 个 rw_* 工具 | 1962 | – | 2026-09-18 |
| `dsh-mcp-panel` | PerryLink/dsh-mcp-panel | MCP 管理控制台 | 1596 | 10 | 2026-09-19 |
| `dsh-client-auto-continue` | HsiangNianian/dsh-auto-continue | 断线自动续跑 | 1475 | – | 2026-09-20 |
| `dsh-win32` | sjh9714/dsh-win32 | 原生 Windows 修复/诊断 | 1136 | – | 2026-09-21 |
| `dsh-strata` | jsdvjx/dsh-strata | 会话滚动条迷你地图 | 722 | – | 2026-09-11 |

**仅按 ★ 排序的头部项目**（stars.json 2026-08-19 快照，部分无 npm 包）：

| 仓库 | ★ | 说明 |
|---|---|---|
| Q00/ouroboros（integrations/dsh-plugin） | 5565 | 外部项目提供的 DSH 集成 |
| omdsh-dev/DSH-better-sidebar | 2216 | 侧边栏工作台（生态里最热的插件之一） |
| ccch1mneyyy/dsh-TUI | 2009 | Claude Code 风格全屏 TUI（16959 周下载） |
| alvinunreal/openpets | 1081 | 桌宠 |
| Anionex/dsh-vision-toolkit | 714 | 视觉工具包（17248 周下载） |
| NanmiCoder/dsh-agent-teams | 573 | 多智能体团队 |
| Nagi-ovo/dsh-ads | 501 | – |
| omdsh-dev/dsh-at-file | 394 | @file 引用 |
| Lum1104/dsh-browser（bridge-browser） | 302 | 浏览器桥 |
| omdsh-dev/dsh-genui | 224 | 生成式 UI |
| Nagi-ovo/dsh-visualize | 180 | 可视化 |
| PC2005-cloud/dsh-pet | 163 | 桌宠 |
| ningbainb/deepseek-harness-desktop | 133 | 桌面端 |
| bradeGithub/DSH-Plugins-Marketplace | 123 | 插件市场 |
| omdsh-dev/dsh-mnemon | 109 | 记忆 |

**按"每仓库下载量"排序的头部**（`data/downloads.json`，checkedAt 2026-08-19，口径与 npm 周下载不同）：
dsh-market 82491、zhu1090093659/dsh-web-ui 59648、ysr666/dsh-vision-router 21679、
Anionex/dsh-vision-toolkit 17248、ccch1mneyyy/dsh-TUI 16959、shaobeichen/dsh-pocket 10411、
vectorize-io/hindsight 9558、THEWOLFWALKER/dsh-notifier 6677、bowenliang123/dsh-context 6612、
sjh9714/dsh-win32 5967、awesome-dsh-plugin/dsh-find-plugin 5892、saya-ch/dsh-mobile 5301、
FuzzySoul/dsh-free-vision 4739、xiajiajun516/dsh-config-manager 4395、Sanqi-normal/dsh-webui-market-plugin 4368。

### 2.1 用户当前 profile 里插件的真实热度（npm downloads API，2026-09-14..20）

| 包 | 周下载 |
|---|---|
| `dsh-context` | 22675 |
| `dsh-cost-meter` | 17581 |
| `dsh-chat-import` | 3949 |
| `dsh-session-manager` | 1894 |
| `@modusensus/dsh-mneme` | 1712 |
| `dsh-diff-approval` | 1626 |
| `dsh-win32` | 1136 |
| `dsh-strata` | 722 |
| `@dsh-plugin/dsh-auxiliary` | 334 |
| `@dsh-plugin/dsh-loader` | 333 |
| `dsh-orchestrator` | 74 |

（对照：`dshmarket` 93668、`@liustech/modlens` → 实为 `@liustack/modlens` 16571。）

---

## 3. 官方（一方）包集合 —— 哪些已经"在树内"

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/README.md>
（每个包都是 `@deepseek-ai/dsh-*`，按能力族分组，共约 60 个组）

| 分类 | 组 |
|---|---|
| 内核/产品骨架 | `core`、`api`、`typert`、`boot`、`host`、`client`、`util`、`test-support`、`runtime-diagnostics` |
| LLM 与 Provider | `llm`（抽象服务 + provider adapters） |
| 执行/沙箱 | `subprocess`、`ssh`、`shell`、`terminal`、`ptc-runtime`、`sandbox`（bwrap/Landlock/Seatbelt）、`computer-use`、`browser-use` |
| 文件/语言服务/外部工具 | `fs`、`lsp`、`mcp`（外部 MCP server 暴露为原生工具）、`document`、`attachment` |
| 会话与存储 | `session`、`session-query`（含 SQLite 全文检索）、`storage`、`compaction`、`spill`、`workspace`、`identity` |
| Web 能力 | `web`（seam + search/fetch providers） |
| 编排与自动化 | `subagent`、`jobs`、`workflow`、`goal`、`schedule`、`todo`、`plan`、`webhook`、`preset`、`bundle`、`extensions` |
| 上下文与技能 | `context`、`skill`、`feedback`、`interaction`（审批/权限/ask-user）、`guard` |
| **Hook 桥** | `hooks` —— **已内置 Claude Code / Codex hook 协议的桥接库** |
| 凭据与设置 | `credentials`（credential seam + env-over-`.env` provider）、`settings` |
| 对外接口 | `sdk`（JSON-RPC）、`acp`（Agent Client Protocol server）、`deliverables` |

**结论**：模型适配、沙箱、LSP、MCP、浏览器/桌面自动化、子智能体、工作流、定时、压缩、会话检索、
技能、凭据 seam、Web GUI、SDK/ACP **都已在树内**。第三方真正剩下的空间在"连接外部世界"和"垂直能力"。

### 3.1 官方扩展点地图（来自 extension-cookbook，写插件必读）

来源：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cookbook/extension-cookbook.md>

| 想要的能力 | 挂载点 |
|---|---|
| 加一个工具 | `ctx.tools.register()` / `defineTool` |
| 权限门/钩子 | `tools/pre-execute` waterfall（返回 `allow/deny/ask`）、`ctx.tools.guard()`、`tools/execute`、`tools/post-execute`、`tools/result` |
| Hook 系统 | `agent/created`、`agent/pre-step`、`agent/request`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping` |
| UI 插件 | `agent/assistant-stream`（流式）+ `session/event`（持久事件）；回写用 `agent.followup()` / `agent.steer()` |
| Web 会话里的业务行 | `ConversationNodeDefinition` + `conversation.chat.node` 渲染器 |
| 外部协议驱动 | 适配 `ctx.agents`（`packages/acp` 是完整范例） |
| 定时任务 | 注册模型可调用的调度工具；空闲 `followup()` / 忙时 `inject()` |
| 记忆 | system-prompt section provider + tool |
| 模型适配 | `LlmAdapter` 子类 + `registerAdapter` |
| 遥测/回放 | `session/event` → JSONL；`sessions.create(id, { seed })` |
| MCP | 每个 server 一个插件：发现工具 → `ctx.tools.register()` |
| 热重载 | 一切注册都是 `ctx.effect`，HMR 自动生效 |

新手上手路径（官方教程，可直接跑）：
`docs/user/develop/basic/index.md`（第一个插件）→ `tool.md`（第一个工具）→ `config.md`（配置）→
`../../../cookbook/adding-a-tool.md`（工具参考）。
本地调试：`pnpm dsh web --patch ./scratch-plugin/cordis.yml`。

---

## 4. 缺口分析

### 4.1 生态拥挤度（GitHub `topic:dsh-plugin` + 关键词的 total_count，**模糊指标**，仅供相对比较）

| 能力关键词 | total_count | 解读 |
|---|---|---|
| mcp | 797 | 极度拥挤 |
| notification | 185 | 拥挤但碎片化 |
| observability / prometheus | 86 | 中等 |
| docker | 45 | 偏薄 |
| kubernetes | 13 | **很薄** |
| github-actions / ci | 9 | **很薄** |
| secret / vault | 2 | **几乎空白** |
| neovim | 1 | **几乎空白** |
| （裸 topic:dsh-plugin） | 15682 | 总量 |

> 注意：GitHub 仓库搜索的关键词匹配是模糊的（会命中 description/name），这些数字只能当"相对拥挤度"用，
> 不能当作精确的插件计数。查询 URL 形如
> <https://api.github.com/search/repositories?q=topic:dsh-plugin+kubernetes&per_page=1>。

### 4.2 明确的缺口清单

| 常见 agent-harness 需求 | 树内是否覆盖 | 生态现状 | 结论 |
|---|---|---|---|
| MCP 集成 | ✅ `packages/mcp` | 797 个相关仓库 + `dsh-mcp-panel` 1596 周下载 | 已饱和，别碰 |
| 通知/IM 桥 | ❌ 只有 `webhook`（外部事件） | 185 仓库但碎片化（`dsh-notifier` 6677、`@xmanrui/dsh-im` 8994、飞书/Lark bot…） | 拥挤；若做应做**provider seam**而非又一个桥 |
| 密钥管理 | ⚠️ 只有 `credentials` seam + env/.env provider | **仅 1 个仓库**（`tancheng33/dsh-credentials-vault`，0★，Vault AppRole 后端） | **真空** |
| 可观测性（OTel/Prometheus/Grafana） | ⚠️ 有 `session/event` seam 与 `runtime-diagnostics`，无导出器 | 86 仓库；`xxiaoxiong/dsh-prometheus` 270 下载 | **薄** |
| CI/CD（GitHub Actions 等） | ❌ 无 | 9 仓库，仅 `Lixiaoyiao/deepseek-harness-action`（16★） | **很薄** |
| 编辑器/IDE 桥 | ⚠️ `lsp` 在树内；无编辑器插件 | VSCode 侧拥挤（`dsh-vscode-mode` 2406、dock 系、open-in-vscode 50★）；**Neovim 仅 1 个仓库 5★** | Neovim **真空** |
| 容器/K8s 部署 | ❌ 无 | docker 45、k8s 13；`runzhliu/deepseek-harness-docker`（90★，含 Helm chart） | **薄** |
| 数据/ETL 连接器 | ❌ 无 | `STARDUSTLC666/dsh-sql` 624 下载、`dsh-data-agent` 55★ | 薄 |
| 语言特定工具（Python/Jupyter/Stata…） | ⚠️ `ptc-runtime` 是 Node 沙箱 | `Stata-AI-Skill`、`dsh-python-env`(1★) 等零星 | 薄 |
| 记忆/RAG | ❌ 无（靠插件） | **极度拥挤**：dsh-mnemon 109★、dsh-mneme、meow-memory、stratagate、memento 58★… | 别碰 |
| 成本/用量统计 | ❌ 无 | 极度拥挤：cost-meter 17581、whale-widget 16592、usage-billing 3185… | 别碰 |
| 主题/皮肤 | ❌ 无 | 极度拥挤（awesome 单列一类 + market 主题 Tab） | 别碰 |
| 会话导航/迷你地图 | ❌ 无 | 极度拥挤（strata、十几款 timeline/rail） | 别碰 |
| 桌宠/娱乐 | ❌ 无 | 拥挤（`fun` 分类） | 别碰 |
| 模型订阅 OAuth | ✅ `llm` adapters | 拥挤（codex-connect、subscriptions、coding-subscription-oauth…） | 别碰 |

### 4.3 真实需求证据（已逐条取得 URL）

主仓库 **Issues 被关闭**（`has_issues:false`，`label:plugin` 查询 total_count=0），需求集中在
**GitHub Discussions**：<https://github.com/deepseek-ai/deepseek-harness/discussions>

| 用户诉求 | 证据 URL |
|---|---|
| 官方应出插件市场，"社区插件的检索功能基本已经废了" | <https://github.com/deepseek-ai/deepseek-harness/discussions/4792> |
| 官方扩展目录 + 稳定服务契约（"缺乏官方支持路径，第三方集成困难"） | <https://github.com/deepseek-ai/deepseek-harness/discussions/5957> |
| 插件级依赖声明与自动激活/去重（`dsh plugin add` 重复注册导致 crash） | <https://github.com/deepseek-ai/deepseek-harness/discussions/5552> |
| 跨版本升级工具（0.1.1→0.1.2 API 破坏） | <https://github.com/deepseek-ai/deepseek-harness/discussions/5120> |
| 运维者诉求：没有官方关闭开关、peer 范围过宽 | <https://github.com/deepseek-ai/deepseek-harness/discussions/5272> |
| 多用户插件认证/授权扩展点 | <https://github.com/deepseek-ai/deepseek-harness/discussions/5868> |
| **插件需要真正的工作区**（编辑器/notebook/终端/预览） | <https://github.com/deepseek-ai/deepseek-harness/discussions/4322> |
| 模型 fallback | <https://github.com/deepseek-ai/deepseek-harness/discussions/5041> |
| 独立客户端 + CLI + **VSCode 插件** | <https://github.com/deepseek-ai/deepseek-harness/discussions/172> |
| macOS 原生客户端（走 ACP） | <https://github.com/deepseek-ai/deepseek-harness/discussions/7358> |
| 会话内 rewind / 原地编辑重发 | <https://github.com/deepseek-ai/deepseek-harness/discussions/4592>、<https://github.com/deepseek-ai/deepseek-harness/discussions/3456> |

市场仓库（issues 开启）：

| 诉求 | 证据 URL |
|---|---|
| 屏蔽/忽略劣质插件更新（防止搞崩宿主） | <https://github.com/dsh-market/dsh-market/issues/657> |
| 安装前 `engines.dsh` 宿主版本预检 | <https://github.com/dsh-market/dsh-market/issues/404> |
| 发现页按宿主 DSH 版本筛选 | <https://github.com/dsh-market/dsh-market/issues/473> |
| **webhook 通知插件**（审批/turn end → ntfy/Bark） | <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/issues/5616> |
| DSH 表面缺口图：无文件系统 markdown-agent loader、无 tool-call 日志、技能发现只有一层 | <https://github.com/dhague/wiki-knowledge/issues/528> |
| 第三方项目主动要 DSH 支持：Apify / **Grafana agento11y（可观测性）** / OpenBitFun | <https://github.com/apify/apify-docs/pull/2974>、<https://github.com/grafana/agento11y/pull/740>、<https://github.com/GCWing/OpenBitFun/issues/3179> |

计数口径提醒：`open_issues_count`（含 PR）与 `is:issue` 总数不同 ——
awesome-dsh-plugin `is:issue` = **73**；dsh-market `is:issue` = **317**。

社区渠道：v2ex 无结果；Reddit 查询失败（UNVERIFIED）；HN 主贴 747 分/314 评论，
另有 ["Ask HN: Anyone using DeepSeek Harness as part of a customer-facing agent?"](https://news.ycombinator.com/item?id=49770744)（5 分，0 评论）。
中文媒体（知乎/CSDN/X）以"必装的 15 个插件"类清单为主 —— 说明**发现需求**强，而非功能诉求。

---

## 5. "第一个插件"候选（可落地）

排序依据：树内 seam 已存在 + 生态薄 + 官方文档可直接照抄 + 有真实需求痕迹。

### 候选 A：云/企业密钥后端（Vault / AWS Secrets Manager / 1Password）
- **做什么**：为 `packages/credentials` 提供 provider，把 API key 从 `.env` 迁到集中式密钥库，支持轮换后不重启。
- **挂载点**：`credentials` seam 的 provider（官方 `adding-a-package.md` / capability layering：Service Definition / Provider / Consumer）。
- **为什么没被覆盖**：树内只有 env-over-`.env` provider；社区仅 1 个仓库 0★。
- **难度**：**小～中**。
- **需求证据**：`topic:dsh-plugin+secret+vault` total_count=2（<https://api.github.com/search/repositories?q=topic:dsh-plugin+secret+vault&per_page=1>）；已有 `tancheng33/dsh-credentials-vault` 证明有人在找这个。

### 候选 B：OpenTelemetry / Prometheus 指标导出器
- **做什么**：把 turn/step/tool 的时延、token、失败率导成 OTel metrics/traces，接 Grafana。
- **挂载点**：`session/event`（持久事件）+ `tools/execute`（包裹 dispatch 做 metrics，cookbook 明示该用法）+ `tools/result`（只读终态）。
- **为什么没被覆盖**：树内只有 `runtime-diagnostics`（包内不变量检查），无导出器。
- **难度**：**中**。
- **需求证据**：cookbook 的 feature→mechanism 表专门列了 "Tool deadline / retry / metrics" 用 `tools/execute`；社区已有 `xxiaoxiong/dsh-prometheus`（270 下载）说明有零星需求但无成熟方案。

### 候选 C：GitHub Actions / CI 集成
- **做什么**：一个官方 Action + 插件：CI 里跑 headless `dsh` 做 code review、CI 失败诊断、Issue→PR。
- **挂载点**：`packages/sdk`（JSON-RPC，进程外）或 `packages/acp`（automation-only ACP server）——**不需要写宿主插件**，风险最低。
- **为什么没被覆盖**：树内完全没有 CI 集成。
- **难度**：**中**。
- **需求证据**：`topic:dsh-plugin+github-actions+ci` total_count=**9**；已有 `Lixiaoyiao/deepseek-harness-action`（16★，AI Code Review / CI Diagnosis / Auto Fix / Issue→PR）。

### 候选 D：Neovim 前端 / 编辑器桥
- **做什么**：nvim 里驱动 DSH（会话、工具卡片、审批、推理面板）。
- **挂载点**：协议驱动模式 —— 适配 `ctx.agents`（照抄 `packages/acp/acp` 的 stdio JSON-RPC 范例），或直接用 `sdk`。
- **为什么没被覆盖**：VSCode 侧已有多个，Neovim 侧仅 `kovey/dsh-nvim-tui`（5★）。
- **难度**：**中～大**（要写 nvim 侧 + Node 桥）。
- **需求证据**：`topic:dsh-plugin+neovim` total_count=**1**（<https://api.github.com/search/repositories?q=topic:dsh-plugin+neovim&per_page=1>）；Claude Code / MCP 生态里编辑器桥是标配（见 §6）。

### 候选 E：Python / Jupyter 内核工具
- **做什么**：把 Jupyter kernel 暴露为 DSH 工具（持久内核、变量检查、notebook 单元格执行）。
- **挂载点**：`ctx.tools.register()` / `defineTool`；持久进程参考 `packages/terminal`（PTY）与 `packages/ptc-runtime`（沙箱 Node）的 provider 形态。
- **为什么没被覆盖**：树内执行面全是 JS/shell/ssh，没有 Python 内核；`ptc-runtime` 只跑 Node。
- **难度**：**中**。
- **需求证据**：社区只有零星的 `dsh-python-env`(1★)、Stata/学术类插件；数据科学是 agent 高频场景（UNVERIFIED 具体需求帖）。

### 候选 F：小型"dsh-tool-*"工具族补充
- **做什么**：按官方 `dsh-tool-*` 家族惯例，补一个单一职责工具（例如 时区/日期计算、单位换算、结构化 diff、编码转换、JSONPath/CSV 查询）。
- **挂载点**：`ctx.tools.register()`，10 行起（官方 `tool.md` 给了完整模板）。
- **为什么没被覆盖**：家族里已有 bash/fs/web/subagent/todo；社区 `omdsh-dev` 用 `dsh-tool-calculator/csv/json/regex/stat/time/markdown/diff/encoding/schema` 验证了这个模式可行且能上榜。
- **难度**：**小**（最适合第一次贡献）。
- **需求证据**：`omdsh-dev/dsh-tool-*` 系列每个 3–6★、均在精选列表内；官方 cookbook 明确称 `dsh-tool-*` 为"shipped examples"。

### 候选 G：容器/K8s 部署与沙箱 provider
- **做什么**：Docker Compose/Helm 打包 + 一个 K8s 沙箱后端（`ctx.sandbox` backend）或容器管理面板。
- **挂载点**：`packages/sandbox` 的 backend seam；UI 面板用 `ConversationNodeDefinition` / 侧边栏。
- **为什么没被覆盖**：树内 sandbox 只有 bwrap/Landlock/Seatbelt（本机进程隔离），没有容器/集群隔离。
- **难度**：**中～大**。
- **需求证据**：docker 45 / k8s 13 仓库；`runzhliu/deepseek-harness-docker`（90★）与 `xiaods/k8e`（496★）说明部署侧有真实需求。

### 候选 H（备选）：通知 **provider seam**（而非又一个桥）
- 树内只有 `webhook`，通知没有 seam；社区 185 个碎片化实现各自为政。
- 做一个 `ctx` 级通知服务定义 + 少量 provider（ntfy/Telegram/Bark/飞书），让其它插件复用。
- **难度**：中；**风险**：与现有热门插件正面竞争（`dsh-notifier` 6677 下载、`@xmanrui/dsh-im` 8994 下载），只推荐给想长期维护的人。

---

## 6. 兄弟生态对照（Claude Code / MCP）

**核心结论（颠覆直觉）**：DSH 生态**已经饱和**了 Claude Code 带火的几乎所有品类 —— 通知、成本、记忆、
安全审计、IM、市场、语音都有多个实现。真正的缺口是**系统性**的（发现层、信任层、成本透明度、组合冲突）。

| 生态 | 代表项目 | URL | DSH 用户为何想要 |
|---|---|---|---|
| Claude Code 插件规范 | 插件 = manifest + skills/agents/hooks/MCP/**LSP servers/monitors/themes/output-styles/workflows/`bin/`** | <https://code.claude.com/docs/en/plugins-reference> | DSH 有 hooks/mcp/lsp/skill/subagent，**没有 output-style 与后台 monitor 等价物** |
| Claude Code 官方市场 | 官方 `claude-plugins-official` 自动加入；`/plugin install n@mkt`；**安装前显示 per-plugin 上下文成本与 "Will install" 预览** | <https://code.claude.com/docs/en/discover-plugins> | DSH 有约 60 个互相竞争的社区市场、**没有官方市场**，且**不显示 token 成本** |
| Claude Code CLI | `claude plugin init\|install\|uninstall\|enable\|disable\|validate\|details` | 同上 | `dsh plugin add` **缺少 validate / details** |
| Claude Code hooks | 约 30 个生命周期事件 | <https://code.claude.com/docs/en/hooks> | DSH 核心有 `packages/hooks`，但**第三方 hook 插件近乎空白**（dsh-hooks ★6、dsh-plugin-hooks ★2） |
| 社区 HUD/statusline | claude-hud ★28,083、ccstatusline ★12,971 | <https://github.com/jarrodwatts/claude-hud> | DSH 侧已被 UI/主题插件饱和 |
| 社区记忆 | claude-mem ★94,382 | <https://github.com/thedotmack/claude-mem> | DSH：graph-memory ★627、dsh-meow-memory ★112 |
| 社区成本 | ccusage ★18,660（310,615 npm 下载/月） | <https://github.com/ccusage/ccusage> | DSH：ANOLISA ★631、TokenLedger ★202、dsh-usage-stats ★161 |
| 多 harness 套件 | wshobson/agents ★39,848、SuperClaude ★23,903 | <https://github.com/wshobson/agents> | DSH：dsh-plugin-subscriptions ★374、dsh-agent-teams ★1,762 |
| MCP 官方 | modelcontextprotocol/servers ★90,523（已拆分，仅 7 个参考 server 留下）；registry ★7,267 | <https://modelcontextprotocol.io/registry/about> | **DSH 的 MCP 客户端在 web profile 里不是默认安装的**（子代理结论，我未复核）→ 最大易得收益 |
| MCP registry API | `registry.modelcontextprotocol.io/v0/servers?limit=N`，reverse-DNS 命名、packages[]/remotes[]、cursor 分页、无 total、preview 状态 | <https://registry.modelcontextprotocol.io/v0/servers?limit=5> | 可作为 DSH 注册表的**蓝图** |
| MCP 上下文压缩 | context7 ★62,273（3.47M npm/月）、headroom ★73,364 | <https://github.com/headroomlabs-ai/headroom> | 直接命中 DSH 的**缓存失效**问题 |
| Awesome 列表 | awesome-mcp-servers ★95,383、awesome-claude-code ★54,384 | <https://github.com/punkpeye/awesome-mcp-servers> | DSH 已有 **10+ 个互相竞争**的列表（awesome-dsh-plugin ★16,499、dsh-web ★7,898、dsh-plugin-radar ★1,464）→ 饱和 |

**MCP 侧饱和 vs 稀薄**：饱和 = 记忆/知识图谱（mem0 ★65,769、graphiti ★31,052）、数据库（sqlite 相关 1,953 个、
postgres 843 个）、浏览器自动化、搜索、文件系统。
**稀薄 = 密钥管理（Vault ★65；未找到官方 1Password 仓库；Doppler 仅 ★0）、Grafana/Sentry 之外的可观测性
（Datadog 官方 ★45）、Slack 之外的聊天平台（Telegram ★348、Discord ★233）。**

**DSH 系统性问题（子代理引用雷锋网/新浪财经 2026-09-01 报道，数据截至 2026-08-25，
<https://finance.sina.com.cn/tech/roll/2026-09-01/doc-iniqihzt8129217.shtml>）**：
- 11,439 个 `dsh-plugin` 仓库 → 2,143 可安装 → **仅 955 真正被使用**；1,883 条拒绝记录中 93% 是"不符合 dsh 安装规则"。
- 官方对插件生态的全部指导 = README/CONTRIBUTING 里一行"加 topic"。**缺失**：插件目录、搜索、版本兼容矩阵、
  签名/校验、安全上报渠道、官方推荐列表。
- ⚠️ **该报道"官方 topic 第 4 名是个 2020 年的简历生成器"这一条，我独立验证成立**：2026-09-21 按 stars 排序的
  `topic:dsh-plugin` 前 10 名依次为 deepseek-harness 232097、open-design 97413、ruflo 72984、archify 68889、
  **reactive-resume（简历生成器）**、OpenViking 38307、DeepSeek-Reasonix 35659、awesome-gpt-image-2 33136、
  WeKnora 28394、anywhere-labs/dsh-desktop 28252
  （<https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=10&page=1>）。
  第 2 页同样混入 PicGo（图床上传器，★27,229）、nocobase（低代码平台，★24,308）、voyager（浏览器扩展，★20,119）。
  **→ topic 作为发现机制已经被严重污染，这是"发现层缺口"的硬证据。**
- 安全：DSH 的 3 档权限（read-only / workspace-write / danger-full-access）**不约束插件** —— 探针插件在三档下
  9 项测试全过（只读档下列出 `~/.ssh/`、从 env 读 API key、写 `/tmp`、联网）。
  ✅ **我独立验证的旁证**：awesome 列表 README 自己就写着 *"Installing a plugin runs third-party code on your
  machine with your own permissions — it can read your files, use your credentials, and reach the network.
  Tool approvals don't sandbox plugin code."*（<https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md>）
- 成本：安装插件会静默使 prompt cache 失效（约 14 个工具描述注入前缀），生态里没有任何提示或计价。
- 冲突：按下载量排名前 10 的插件**无法共存安装**（第 2/3/6 名冲突）。

**社区需求（Reddit/HN/V2EX）**：多智能体编排与 agent 可观测性、上下文/token 治理（V2EX 量化：5 个 MCP server
= 25,000 tokens / 12.5%）、权限粒度（HN："每次审批"与"YOLO"之间需要更细的界面）、hook 生命周期、
记忆与遗忘。⚠️ 注意：**不存在严格的量化需求调研**，所有"最想要"排名都是定性的 → 数值化需求排序 UNVERIFIED。

---

## 7. 方法与可信度说明

- npm 名称全部经 `registry.npmjs.org` 校验；周下载来自 `api.npmjs.org/downloads/point/last-week/<pkg>`
  或 `registry.npmjs.org/-/v1/search`（返回体自带 downloads 字段）。
- ★ 数来自 awesome-dsh-plugin 仓库 `data/stars.json`，**快照时间 2026-08-19**，因此系统性偏低约一个月。
- 每仓库下载量来自 `data/downloads.json`（同样 2026-08-19 快照），与 npm 周下载口径不同，**不要混用**。
- 本次调研中 GitHub 未认证 API 曾触发速率限制（HTTP 403），少数补充查询未能执行；
  文中凡未取得 URL 佐证的条目均已标注 UNVERIFIED。
- 本机 PowerShell **无网络访问**，全部数据经 `web_fetch` 获取；GitHub/npm 的 JSON 响应超过约 100KB 会被截断，
  因此采用小分页与逐条 API 查询。
