# dsh-agentos-remote

让手机 WorkBuddy App 直接控制任意 DSH 实例的插件。实现 WorkBuddy 的 AgentOS「本地代理」远控协议(逆向自 WorkBuddy 桌面端并经腾讯线上服务逐环节实测)。

**完全独立运行:目标机器不需要安装 WorkBuddy**——内置微信扫码登录,凭据自动持久化与续期。

## 工作原理

```
手机 WorkBuddy App
      │ 同一账号
      ▼
AgentOS 云端
      │  Centrifugo WebSocket(下行任务)
      ▼
dsh-agentos-remote
  ├─ 凭据三级发现:扫码登录缓存 → 本机 WorkBuddy 会话(若有)→ 环境变量
  ├─ registerWorkspace 注册 DSH 工作区
  ├─ 订阅 channel 接收手机任务
  ├─ 任务 → ctx.agents.create + followup → DSH Agent 执行
  ├─ 结果 → HTTP COPILOT_RESPONSE 回传 App(失败自动重试)
  └─ refreshToken 自动轮换续期 → 一次扫码长期有效
```

## 登录(微信扫码,无需 WorkBuddy)

安装后重启 DSH,打开 DSH Web UI,**在左侧栏点手机图标,打开「WorkBuddy 远控」面板**:

面板里直接显示二维码 → 微信扫码确认 → 面板提示"登录成功" → 插件自动注册上云。

- 面板同时显示实时链路状态(未登录 / 等待登录 / 链路连接中 / 链路已连接 / 链路已停止)、账号、设备名与工作区。
- 侧栏图标右上角出现**黄色小点 = 当前尚未登录**(图标每 30 秒探测一次状态),点进去扫码即可。
- 已登录后想换账号,面板里的「重新扫码登录」会重新走一遍扫码流程。

这份 UI 由本包的**浏览器侧**提供(`dsh.client` + `lib/client.js`),它占用 DSH 客户端的两个槽位:
侧栏列表槽 `sidebar.panellist`(id `agentos-remote`)与主面板键控槽 `main`(key `agentos-remote`)。
它只调用下面那几个同源 HTTP 路由,不额外建立任何连接或通道。

面板不可用时(旧版宿主、纯 SSH、或 profile 里没有 `webServer`),同一份二维码也在独立页面上:

```
http://<你的DSH地址>/agentos-remote/login
```

⚠️ 设 `enabled: false` 停用插件后,**宿主侧的路由会消失,但侧栏入口仍在**——客户端侧是独立加载的,
读不到宿主配置。此时点开面板会显示"读不到远控状态(插件未启用或路由不可达)",图标也不会亮黄点。
要彻底去掉入口,请把插件从 profile 的 bundles 里移除(`dsh plugin --profile <名字> remove dsh-agentos-remote`)。

无 Web UI 时也可命令行登录(终端二维码):

```
node node_modules/dsh-agentos-remote/login.js
```

凭据保存在 `~/.workbuddy/.dsh-agentos-credentials.json`,重启无需重新扫码(refreshToken 自动轮换续期)。

- 回推端点:`POST {endpoint}/v2/backgroundagent/localProxy/receive`(实测 HTTP 200)
- 链路保活:每 30 分钟 ping,服务端报 `RE_REGISTER_WORKSPACE` 即重注册;connectionToken 7 天 TTL 兜底
- 任务去重:按 `requestId`,5 分钟窗口(防 Centrifugo 重放导致重复执行)
- 面板状态端点:`GET /agentos-remote/login/api/status`(只读快照,见下方安全提示)
- 登录流(逆向自 WorkBuddy ExternalLinkAuthenticationProvider,全部实测):
  `POST /v2/plugin/auth/state?platform=workbuddy` → 服务端下发 authUrl → 用户认证 → 轮询 `/v2/plugin/auth/token?state=` → `/v2/plugin/login/account` → `/v2/plugin/accounts`

## 配置(cordis.patch.yml / 环境变量)

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 设 `DSH_AGENTOS_REMOTE_ENABLED=false` 可整体停用 |
| `endpoint` | `https://tencent.sso.codebuddy.cn` | AgentOS API 基址 |
| `agentType` | `workbuddy` | 注册的 localAgentType。**不要改成别的值**:服务端由它派生 Centrifugo 的 channel 命名空间 `copilot_<type>:…`,而手机 App 只枚举 `copilot_workbuddy`——注册成 `cli` 会成功但设备在 App 里永远不出现 |
| `sessionFile` | 按平台自动发现 | WorkBuddy 会话文件路径覆盖 |
| `workspaceDir` | DSH 启动目录 | 暴露给手机的工作区目录 |
| `deviceName` | `{主机名}-DSH` | 手机 App 里显示的设备名(与 WorkBuddy Desktop 并列为独立设备) |
| `provider` / `model` | 跟随宿主 | 任务使用的模型路由 |
| `debug` | `false` | 回传 task-start 事件 |

环境变量(优先于配置):`DSH_AGENTOS_ACCESS_TOKEN` / `DSH_AGENTOS_SESSION_FILE` / `DSH_AGENTOS_USER_ID` / `DSH_AGENTOS_DOMAIN` / `DSH_AGENTOS_ENTERPRISE_ID`。

凭据来源按序(全部实测):
1. 扫码登录缓存:`~/.workbuddy/.dsh-agentos-credentials.json`(推荐,自动续期)
2. WorkBuddy 桌面会话:Windows `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\` / macOS `~/Library/Application Support/CodeBuddyExtension/...` / Linux `~/.local/share/CodeBuddyExtension/...`
3. 环境变量 `DSH_AGENTOS_ACCESS_TOKEN`

## 安装

本插件是 [dsh-plugins](https://github.com/BeGild/dsh-plugins) monorepo 里的一个包，三种安装方式（tarball / git / npm）见 [INSTALL.md](./INSTALL.md)。

⚠️ **全新 profile 上先放行 `protobufjs` 的构建脚本**（`centrifuge` 的依赖，pnpm ≥10 默认拒绝执行，且拒绝是致命的）：
在该 profile 的 `pnpm-workspace.yaml` 里写 `allowBuilds: { protobufjs: true }`，否则 `dsh plugin ... add` 会以
`ERR_PNPM_IGNORED_BUILDS` 失败。web 模板新建的 profile 里这一项是占位串，原样保留就会踩到。细节见 INSTALL.md。

## 安全提示

**插件代码不受 DSH 三档文件权限约束**——`read-only` / `workspace-write` / `danger-full-access` 只审查模型发起的工具请求，插件代码以你的用户账号全部权限运行。本插件额外做这些事，都写在明处：

- 持有你的 WorkBuddy 账号凭据并调用腾讯 AgentOS **私有接口**（非公开协议，腾讯侧可能随时变更）。
- 凭据明文保存在 `~/.workbuddy/.dsh-agentos-credentials.json`（与 WorkBuddy 桌面端同级风险）。
- 出网连接到 `tencent.sso.codebuddy.cn` / `copilot.tencent.com` 与云端 Centrifugo WebSocket；不读取凭据以外的本机文件。
- **登录页与状态接口不带鉴权**：`/agentos-remote/login` 及其 `/api/*` 挂在 DSH Web 服务上，能访问你 DSH Web UI 的人就能打开它、读到 `/api/status` 返回的 uid / 昵称 / 设备名 / 工作区名，也可能发起一次扫码登录（但登录必须由**你的手机在微信里确认**才会生效）。这些接口不返回任何 token、refreshToken 或通道凭据。浏览器侧只调用这几个同源路由，不额外出网。

**装了这个插件 = 你的 WorkBuddy 手机账号可以驱动这台机器上的 agent**（包括 shell 与文件工具）。仅建议在个人设备、自担风险使用。

## 与其他远程控制插件的冲突面

AGENTS.md §10.3 要求声明冲突面。本插件会占用：

- Web 路由 `/agentos-remote/login`（登录页）与 `/agentos-remote/login/api/*`（登录与状态 API）。
- DSH 客户端槽位：侧栏 `sidebar.panellist` 的 id `agentos-remote`、主面板 `main` 的 key `agentos-remote`。两者都是**未占用的加法位**（不覆盖任何官方 UI）；若另一个插件也用这两个 id，会互相覆盖。
- 服务名 `agentosRemote`（Cordis Service 注册名）。
- 一条通往腾讯云的常驻 WebSocket。

同类的「手机遥控 DSH」插件（`dsh-remote-access` 的反向代理配对页、`dsh-remote-channel` 的 chat 页、`@linxin666/dsh-remote-web-ui` 的扫码配对）各自占用不同的路由与端口，**可以共存**；但如果某个插件也注册了 `agentosRemote` 这个服务名，或占用同名路由，两者会互相覆盖。真装在一起时以 `dsh --profile <名字> --dump-config` 看到的行为为准。

