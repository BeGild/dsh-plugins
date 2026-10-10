# 安装到任意 DSH 实例

三种方式,按场景选择。**目标机器完全不需要安装 WorkBuddy**——装好插件后用微信扫码登录即可。

## 方式一:从 tarball 安装(离线/内网,最直接)

`dsh-agentos-remote-1.2.0.tgz` 随本包分发。在目标机器上:

```powershell
dsh plugin --profile <你的profile名> add E:\path\to\dsh-agentos-remote-1.2.0.tgz
```

DSH 会通过 pnpm 安装 tarball、校验 dsh manifest、把 `agentos-remote` 追加进 `dsh.profile.bundles`,重启 DSH 即生效。

> tarball 也可手动安装:把 `dependencies` 里加 `"dsh-agentos-remote": "file:E:/path/to/dsh-agentos-remote-1.2.0.tgz"`,再在 `dsh.profile.bundles` 数组加 `"dsh-agentos-remote"`,然后 `pnpm install`。

### ⚠️ 全新 profile 上必做的一步:放行 protobufjs 的构建脚本

`centrifuge` 依赖 `protobufjs`,而 pnpm ≥10 **默认拒绝执行依赖的构建脚本**,且拒绝是致命的:

```
Error: ERR_PNPM_IGNORED_BUILDS
  × adding a new package
  ╰─▶ Ignored build scripts: protobufjs@7.6.6
```

装之前先在该 profile 的 `pnpm-workspace.yaml`(`$DSH_HOME/profiles/<名字>/pnpm-workspace.yaml`)里放行:

```yaml
allowBuilds:
  protobufjs: true      # 显式 true 或 false 都可以;关键是别留空、别留模板占位串
```

从 web 模板新建的 profile 里这一项是占位串 `protobufjs: set this to true or false`,**原样保留就会报上面这个错**。改完重新执行一次 `dsh plugin ... add` 即可(命令会失败在安装步骤,不会写坏 profile)。

`protobufjs` 的 postinstall 只服务于它自己的 CLI,插件运行并不需要,所以写 `false` 同样能装成功——写 `true` 只是少一次"为什么是 false"的疑问。

## 方式二:从 git 仓库安装(团队分发)

把插件目录推到任意 git 仓库(GitHub / 内网 Git):

```powershell
dsh plugin --profile <你的profile名> add github:<owner>/<repo>
# 或完整 URL / 指定分支 / 子目录:
dsh plugin --profile <profile> add git+https://git.example.com/team/dsh-agentos-remote.git
```

仓库要求:根目录就是插件根(含 `package.json` + `cordis.patch.yml` + `lib/`),**不要**把 `node_modules` 提交进去。

## 方式三:发布到 npm(公共/私有 registry)

```powershell
cd dsh-agentos-remote
npm publish            # 或 npm publish --registry <私有registry>
dsh plugin --profile <profile> add dsh-agentos-remote
```

发布后可进入 DSH 插件市场搜索安装(market 要求:`latest` dist-tag 指向稳定版、`dsh.bundle.patch` 路径有效)。

## 登录(微信扫码,目标机器无需 WorkBuddy)

重启 DSH 后,打开平时访问 DSH Web UI 的地址,**在左侧栏点手机图标,打开「WorkBuddy 远控」面板**:

1. 面板自动生成二维码(侧栏图标右上角的黄色小点 = 尚未登录)
2. 微信扫码 → 确认登录
3. 面板显示"登录成功: <你的昵称>",状态变为「已登录 · 链路已连接」
4. 完成 —— 插件自动用该账号注册 DSH 工作区到 AgentOS 云端,手机 App 里即可看到并下发任务

面板打不开时(旧版宿主、纯 SSH、profile 无 `webServer`),同一份二维码也在独立页面上:

```
http://<你的DSH地址>/agentos-remote/login
```

凭据保存在 DSH 机器的 `~/.workbuddy/.dsh-agentos-credentials.json`,refreshToken 自动轮换续期,**后续重启无需再扫码**。

无 Web UI 的环境(纯 SSH)也可终端登录: `node node_modules/dsh-agentos-remote/login.js`(终端里显示 ASCII 二维码)。

## 验证安装成功

重启 DSH 后,日志中应出现:

```
[agentos-remote] login page: /agentos-remote/login (also a panel in the DSH web UI)
[agentos-remote] session source: cached-login (uid=<uid>)     ← 扫码后
[agentos-remote] registered workspace=<目录名> channel=copilot_workbuddy:<uid>_<hostId>_<ws>
[agentos-remote] connected client=<uuid>
[agentos-remote] subscribed: copilot_workbuddy:<uid>_<hostId>_<ws>
```

## 常见问题

| 现象 | 处理 |
|---|---|
| 装的时候 `ERR_PNPM_IGNORED_BUILDS: protobufjs@7.6.6` | 见上方「全新 profile 上必做的一步」:在 profile 的 `pnpm-workspace.yaml` 里写 `allowBuilds: { protobufjs: true }`,或跑 `pnpm approve-builds` |
| 日志 `no credentials — open /agentos-remote/login` | 正常:扫码前都这样;点侧栏「WorkBuddy 远控」或打开登录页扫码即可 |
| 侧栏看不到「WorkBuddy 远控」入口 | 确认宿主带 `@deepseek-ai/dsh-web-app`(标准 web profile 都有);`dsh --profile <名字> --dump-config` 里能看到 `dsh-agentos-remote` 这一层 |
| 二维码过期 | 面板/页面点「刷新二维码」(state 5 分钟有效) |
| 日志 `token refresh failed` | refreshToken 可能已失效(长期未运行)→ 重新扫码 |
| 收到任务但 `reply failed ... 404 No channel mapping` | 正常现象:通道映射有约 2 秒传播延迟,插件会自动重试;若持续失败检查 endpoint 配置 |
| 手机 App 里看不到工作区 | 确认手机 App 与扫码账号为同一账号;workspace 在注册后才会出现 |
| pnpm 报 peer 依赖 | `@deepseek-ai/cordis` 由 DSH 宿主提供,装不上时确认目标实例版本 ≥ cordis 4 |
