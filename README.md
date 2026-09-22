# dsh-plugins

[![ci](https://github.com/BeGild/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/BeGild/dsh-plugins/actions/workflows/ci.yml)

我自己的 **DeepSeek Harness 插件 monorepo**。一个插件一个包，全部在 CI 里过契约门禁。

配套仓库 **[EkkoBuddy](https://github.com/BeGild/EkkoBuddy)** 负责把这些插件和外部插件、
以及我的配置汇总成一台可复现的 DSH 安装。

```
plugins/
  dsh-apply-patch/      apply_patch  — 结构化多文件补丁，一次调用原子应用
  dsh-persistent-repl/  node_repl    — 持久化 Node.js REPL，跨调用保留顶层绑定
scripts/
  validate.mjs        契约门禁（R1–R10）
  test-all.mjs        跑所有插件的测试
  list.mjs            清单
```

## 用法

```sh
pnpm install                  # 装 devDependencies（测试需要官方 peer 包，见下）
node scripts/list.mjs         # 有什么
node scripts/validate.mjs     # 契约门禁（非 0 退出 = 有问题）
node scripts/test-all.mjs     # 跑测试
```

`pnpm install` 是**必需**的：插件的运行时依赖只有官方 `@deepseek-ai/*` 包，
它们声明为 `peerDependencies`（由宿主提供），同时在 `devDependencies` 里镜像一份
——这正是 AGENTS.md §3.2 推荐的写法，也是让 load/integration 测试能在没有宿主的
机器上跑起来的原因。少了它，测试会以
`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'` 失败
（CI 第一次跑就是这么挂的）。

## 契约门禁检查什么

`scripts/validate.mjs` 把 `AGENTS.md` 的硬规则变成可执行检查，
因为文档里写的"最常见的被拒原因"全都是机械可查的：

| 规则 | 检查 |
|---|---|
| **R1** | `dsh.bundle.patch` 存在且指向真实文件 ← **最常见的被拒原因** |
| **R2** | `cordis.patch.yml` 顶层是数组；某行的 `name` 等于包名；行 id 全局唯一 |
| **R4** | 官方 `@deepseek-ai/*` 在 `peerDependencies`，不在 `dependencies` |
| **R5** | `@deepseek-ai/dsh-*` 的 peer 范围带预发布分支（否则静默排除所有预发布版 DSH） |
| **R7** | `dependencies` 里没有 `file:`/`link:`/`github:` 等非 registry 说明符 |
| **R8** | 描述以句号结尾、`repository.url` 指向 GitHub、README 有实质内容 |
| 其他 | `type: module`、`main` 指向存在的文件、`files` 含构建产物与 patch、`keywords` 含 `dsh-plugin`、client 插件必须有 `./client` export |

`validate.mjs` 是**结构检查而非完整 YAML 解析器**：它只提取契约关心的几个事实
（顶层是不是数组、出现哪些行 id 和 `name`），以保持零依赖。这一点是刻意的取舍。

## 加一个新插件

```sh
mkdir -p plugins/dsh-my-thing/lib plugins/dsh-my-thing/test
```

`package.json` 的最小骨架：

```jsonc
{
  "name": "dsh-my-thing",
  "version": "0.1.0",
  "description": "One accurate line ending with a period.",
  "type": "module",
  "main": "lib/index.js",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/BeGild/dsh-plugins.git", "directory": "plugins/dsh-my-thing" },
  "engines": { "node": ">=20" },
  "keywords": ["deepseek-harness", "dsh", "dsh-plugin"],
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "exports": { ".": "./lib/index.js", "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
  "files": ["lib", "test", "cordis.patch.yml", "README.md"],
  "publishConfig": { "access": "public" }
}
```

```yaml
# cordis.patch.yml — 顶层必须是数组，name 写包名
- insert:
    - id: dsh-my-thing
      name: dsh-my-thing
```

然后 `node scripts/validate.mjs` 必须 PASS，`node scripts/test-all.mjs` 必须全绿。

## 本地开发时 peer 怎么解析

插件源码在 `plugins/<name>/lib/` 里 `import '@deepseek-ai/dsh-tools'`。
在仓库根跑一次 `pnpm install`，pnpm 会把每个插件的 `devDependencies`
装进 `plugins/<name>/node_modules/`，测试即可直接解析到这些官方包——
**不需要任何 junction / 软链技巧**。

真实安装时（用户机器上）peer 由 profile 的 `nodeLinker: hoisted` 提供，
见 EkkoBuddy 的说明。同一份代码在两种环境下都能解析，只是来源不同。

## 发布

```sh
cd plugins/dsh-my-thing
npm publish            # 或 pnpm pack 出 tarball
```

发到 npm 之后，去 EkkoBuddy 把对应条目的 `enabled` 改成 `true`。

想进社区精选清单（<https://awesome-dsh-plugin.com>）：给仓库加 `dsh-plugin` topic，
然后向 `awesome-dsh-plugin/awesome-dsh-plugin` 提一个只加
`data/plugins/BeGild__dsh-plugins--plugins-dsh-my-thing.yml` 的 PR（monorepo 子包命名法）。

## 安全

插件代码**不受** DSH 的三档文件权限约束——那三档只审查模型发起的工具请求。
插件在用户机器上以该用户账号的全部权限运行。所以：

- `dsh-persistent-repl` 会执行任意 JavaScript（与内置 shell 工具同级信任）；
- `dsh-apply-patch` 直接读写文件，不受文件沙箱限制，靠 `rootDir` / `allowOutsideRoot` 约束。

两个插件的 README 都写明了这一点，且都不自行联网、不读取凭据。
