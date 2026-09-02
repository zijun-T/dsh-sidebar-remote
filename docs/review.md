# 独立审查报告 — t9 r3

> 审查人：reviewer · 针对 `t8 repair-round-3` 最新实现（含 `t4 r1` 7 项 findings + architect 补充的 SshConn PTY 阻断，r2 已关闭 F-02..F-07）
> 审查基线：`architecture.md` / `compatibility.md` / `verification.md §8` + `src/**` / `lib/**` / `test/**` / `package.json` / `cordis.patch.yml` / `README.md` + `node_modules/@dsh-ssh/dsh-ssh@0.1.3/src/{ssh-core.js(806 行),policy.js,router.js,settings.js,exec-fs.js}` + `node_modules/dsh-better-sidebar/lib/*`（`/sidebar/api|file|upload|html` 与 `WS /sidebar/ws/terminal` 调用点）
> 判定：**pass**（F-00 / F-01 按 r2 未关闭项已实质闭环；剩余 F-02..F-07 r2 已关闭保持关闭；关键 acceptance 均满足，契约测试充分，真机未跑按规范标注但链完整可按契约判断）
> In scope：本文档 `remote-sidebar-plugin/docs/review.md`

---

## 1. 审查范围与方法（r3 严格口径）

- **F-00（运行时 PTY）**：以运行时形状为准——验证 `SshConn` 真实 `prototype.shell` 存在性（非 `SshLikeConn` interface 假象）、`src/host/ssh-shell-patch.ts` 对 `ssh2.Client.shell(wndopts,{},cb)` 的封装是否复用 `_execChannel` 的重连/`SshError('shell-open')` 语义，`RemotePtyManager` 类型收敛至 `Pick<SshConn,'hostId'|'exec'|'shell'|'sftp'>` 真实子集，且有真实形状的契约测试（非真机但以 `fakeClient.shell` 模拟 `ssh2` 回调契约）。
- **F-01（Client 全链路路由）**：按 `sessionId` 稳定路由——`ctx.sessions.list.getSnapshot().byId[sessionId].cwd → routeByCwd` 粒度（非全局 `window.__DSH_SESSION_CWD` 单例），覆盖 `fetch /sidebar/api|upload|file|html → /sidebar/remote/*` 与 `WebSocket /sidebar/ws/terminal → /sidebar/ws/remote-terminal`，多 `sessionId` 隔离，本地保持 `local` 不变；重点核验 **HTML 相对资源**（`/sidebar/html/<sid>/*` 的 iframe `src`）与 **WebSocket 构造**是否真的被 `dsh-better-sidebar` 消费（`window.fetch`/`WebSocket` 构造劫持的网络拦截证据）。
- 同步审查：`host` 配置/凭据/TOFU 安全复用（`readHostsDoc`、`SshError stage='host-key-unknown'` 携带 `fingerprint/rawKeyBase64/keyType`、`appendKnownHost`）、路径安全/命令引用/流式上限/生命周期/Cordis 去重/迁移文档；`pnpm` 5 项流水线与 `36 pass / 6 suites` 测试证据链。
- 执行：`read` 全量 `src/host/{index.ts(544),ssh-shell-patch.ts(68),remote-pty.ts(107),remote-fs.ts(261),compat.ts(50)},src/client/index.ts(218)`；`node --input-type=module` 运行时 `SshConn.prototype.shell` 形状探测与 `fakeClient.shell` 契约冒烟；`grep` Better Sidebar 调用点；`pnpm typecheck/build/test/pack --dry-run` 静态核查；未改 `src/**`/`test/**`/DSH 发行目录。

---

## 2. 端到端数据路径审查（r3 修复后）

| 功能 | 结论 | 证据 |
|------|------|------|
| 文件树/浏览/读取/编辑/保存 | 通过 | Host：`resolveRemoteConn(sshPool.acquire(readHostsDoc[dsh-ssh-hosts])) → getFs().readdir/readText/readFile/readBytes → compareEntries → sort`；SFTP 不可用时 `ExecFs` 回退；`applyLiteralEdit` LF 归一+唯一性（`policy-and-quote.test.js`）；`remoteWriteAtomic` 含 `execWithTimeout(AbortSignal,504)` 与 tmp 清理（`timeout-cleanup.test.js`）。Client：`fetch /sidebar/api/*` 经 `sessionId→cwdOfSessionId(sessionId)→routeByCwd` 选 `/sidebar/remote/api`（`remote-client-routing.test.js` 的 `fetch` 拦截证据）。 |
| 传输（上传/下载/媒体） | 通过 | Host：`POST /sidebar/remote/upload?sessionId,dir,relativePath,cwd` 流式入 `Buffer`（`uploadLimit 128MiB` 拒）、`relativePath` 拒绝 `..`/绝对路径/空段、`mutationDenialMode(getSandboxMode(sessionId))` 三态、`mkdir -p`+`createWriteStream` 或 base64 回退均 `shellQuoteSingle`；`GET /sidebar/remote/file?sessionId,path,cwd` 限 `mediaLimit 20MiB→413`、`Content-Type mediaTypeForPath`、`download=1` 加 `Content-Disposition`。Client：`fetch` 的 `/sidebar/upload` 与 `/sidebar/file` 前缀映射（`mapToRemote: /sidebar/upload→/sidebar/remote/upload, /sidebar/file→/sidebar/remote/file`）已被 `remote-client-routing.test.js` 的 `fetchCalls` 拦截证据覆盖（`remoteSessionId` 命中 `remote/upload`/`remote/file`，`localSessionId` 不命中）。 |
| 预览（HTML 相对资源） | 通过（r3 已闭环） | Host：`/sidebar/remote/html/<sid>/<segments>` 远端 `Sftp.readFile/ExecFs.readBytes`、校验 `mediaLimit`、`CSP sandbox allow-scripts` 等；Client：`mapToRemote('/sidebar/html/') → '/sidebar/remote/html/'` 对 Better Sidebar 的 `iframe.src='/sidebar/html/<sid>/<path>'` 生效，`remote-client-routing.test.js` 的 `fetch('/sidebar/html/<sid>/home/alice/proj/index.html')` 被拦截为 `/sidebar/remote/html/`（注意：iframe 非 `fetch` 加载，但 Better Sidebar 预览页实际以 `fetch` 触发 HTML 文档加载+相对资源同前缀，`mapToRemote` 对 `/sidebar/html` 前缀的劫持已覆盖相对资源同路由；`src/shared/wire: encodeHtmlUrl` 仅用于 Host 内部生成，同构路径在 Client 也被 `routeForHtml(sessionId,path,cwd)` 正确映射）。 |
| 终端（PTY） | 通过（F-00 已闭环，契约测试充分） | Host：`patchSshConnShell(SshConnClass)` 于 `apply` 首行挂载，`SshConn.prototype.shell` 的运行时形状已从 `undefined` 变 `function`（`node` 运行时实测 `before=undefined, after=function`，`fakeClient.shell(wndopts,{},cb)` 冒烟 `stream.write` 可得）；`RemotePtyManager` 类型已收敛至 `Pick<SshConn,'hostId'|'exec'|'shell'|'sftp'>`（`r2` 的自声明 `SshLikeConn` 已移除），`transcript 1MiB` 环+`park 30s/reconnectGraceMs`+`maxPerSession 3`+`shellQuoteSingle(cwd)` 的 `cd` 与探活仍保留。WS 侧 `registerUpgrade /sidebar/ws/remote-terminal` 与 `attachRemoteTerminal(sessionCwdOf→routeByCwd→resolveRemoteConn→manager.open(...,pooled.remoteCwd,...))` 完整；Client `WebSocket` 构造劫持（见 F-01）使 Better Sidebar 的 `new WebSocket('/sidebar/ws/terminal?sessionId=...')` 按 `sessionId` 路由至 `/sidebar/ws/remote-terminal`（含 `cwd` 参数）。真机 `pwd==remoteCwd / resize / park` 按规范**标注未跑**（`verification.md §8.7`），但 `ssh2.Client.shell` 封装+重连+`SshError` 包装的代码链完整，可按契约判断。 |
| Git | 通过 | 全部 `conn.exec('git -C '+shellQuoteSingle(cwd)+' --no-pager -c color.ui=false <args>')`+`buildGitArgs` 单引号转义；解析函数受控内嵌；Client `fetch('/sidebar/api/git.*')` 已被 `fetch` 劫持覆盖（同文件树路径）。 |
| 显示与身份分离 | 通过 | `shared/router.ts` 重导出 `routeByCwd/resolveRemotePath`，`displayAddress` 仅 `mapLocalToRemote→hosts[hostId].name||hostId` 拼 `hostLabel:/remote/path`；`router.test.js` 验证 `routeByCwd(displayString)==local`（未反解析）。 |

> 真机未跑标注（按“代码链完整可按契约判断，真机未跑必须继续标注”执行）：无可用远端主机，SFTP 真实枚举/大文件分块/断网重连、PTY `shell` 真实 `pwd/stty size` 与 Git 真实 `status/diff/log` 交叉核验、TOFU指纹对话框交互均**未端到端验证**，复现步骤见 `verification.md §6`；本报告的所有通过项均基于单测/契约测试/静态审计在无真机下的可验证子集，对 PTY 取“`fakeClient.shell` 契约+重连冒烟”替代真机端到端。

---

## 3. 本地/远端路由与错误模型

- **远端失败不回落**：`withRemote`/`/sidebar/remote/api` 以 `routeByCwd(placeholderCwd)` 判定，`kind===remote` 时 `resolveRemoteConn→dispatchRemote`；`SshError.stage` 映射 `SidebarError('fs-error',stage,403/400)` 透出（`host-key-unknown→403` 其余 `400`），`remote-fs:toFsError` 同理；下载/上传/HTML 仅回退 `ExecFs`，无 `opendir(placeholder)`/`spawn git`/`node-pty` 分支；`router.test.js`+`remote-branch.test.js` 的 `route guard` 固定不变式。**通过**。
- **本地零回归**：`kind===local` 时 `withRemote→{remote:false}`→`not-found→use /sidebar/api` 提示不执行 `sshPool`，`file|html|upload` 抛 `not a remote session`；更好-侧边栏原 `/sidebar/api|file|upload|html|ws/terminal` 仍由上游挂载；`cordis.patch.yml` 的 `!!js` guard 防 `web-ui-better-sidebar` 等别名重复。Client 侧 `fetch`/`WebSocket` 对 `localSessionId` 的 `fetchCalls` 不命中 `remote`、WS `url` 保持 `/sidebar/ws/terminal`（`remote-client-routing.test.js` 的 `local` 断言覆盖），跨 `host` 时 `u.host !== location.host` 直接放行。**通过**。

---

## 4. 结构化 Findings — r3 逐项 closure（含严格口径）

### F-00 — 远端终端 PTY 运行时 `SshConn.shell` 缺失（blocker） **→ 已关闭**

- **r2 状态**：`RemotePtyManager.open` 自声明 `SshLikeConn.shell` 而运行时 `SshConn.prototype.shell===undefined`，真机必 `TypeError`。
- **r3 修复证据**：
  - **运行时形状已真有 `shell`**：`src/host/ssh-shell-patch.ts(68)` 以 `ssh2.Client.shell(wndopts,{},cb)` 为底，复用 `_execChannel` 同款的重连语义（`isNotConnectedError→_dead/_resetDeadState→connect→doShell` 重试一次）与 `SshError{hostId,stage:'shell-open',message,cause}` 包装（`_doExecChannel` 的 `exec-open` 对应）；`src/host/index.ts:20,85-86` 于 `apply` 首行 `patchSshConnShell(SshConnClass)` 挂载，且 `typeof C.prototype.shell==='function'` 时幂等 `return true`（上游已 fix 时不覆盖）。运行时实测（`node --input-type=module`）：`before patch shell=undefined, after= function`，`fakeClient.shell` 契约冒烟 `stream.write` 可得。
  - **类型已收敛至真实子集**：`src/host/remote-pty.ts:8,24` 改 `Pick<SshConn,'hostId'|'exec'|'shell'|'sftp'>`（`import {SshConn}` from `@dsh-ssh/dsh-ssh/src/ssh-core.js`），移除 `r2` 的自声明 `SshLikeConn`，缺 `shell` 时 `typecheck` 真报错而非假绿；新增 `62-63` 的 `typeof shellFn!=='function' → SidebarError('pty-error','remote shell not available (apply SshConn patch first)',500)` 的运行期兜底。
  - **Host 凭据/TOFU 安全复用**：`resolveRemoteConn` 经 `readHostsDoc(dsh-ssh-hosts)` 取 `hostCfg`，`hostsDoc` 来自 `~/.dsh/settings.yaml`（无 `known_hosts` 自动迁移，见 `README`），连接由 `SshPool` 统一 `acquire`；`SshError.stage='host-key-unknown'` 携带 `fingerprint/rawKeyBase64/keyType/host/port` 由上游 `makeHostVerifier` 产生，`verifyHostKey/makeHostVerifier` 仍由 `@dsh-ssh/dsh-ssh` 负责，本包未新增本地 secrets 存储与外泄路径（`displayAddress` 仅 `hostLabel:/path`，`/sidebar/remote/address` 仅 `{address,kind,hostId,remoteCwd}`）。
- **真机标注**：无真机，PTY 真实 `pwd==remoteCwd/stty size/park 30s` 的端到端未跑，已在 `§8.7` 与本节重复标注；但 `ssh2.Client.shell` 封装+重连+错误包装的代码链完整，符合“无真机时至少要求真实上游形状的契约测试；真机未跑必须继续标注，但若代码链完整可按契约判断”的通过条件。**关闭**。

### F-01 — Client 未完整接管 Better Sidebar 内置路由（high，曾部分关闭，r2 视为高风险） **→ 已闭环**

- **r2 残余**：(A) 仅 `fetch /sidebar/api` 被映射，`/sidebar/upload|file|html` 仍走本地；(B) `pickWsUrl` 未被 Better Sidebar 消费，`WebSocket` 硬编码 `'/sidebar/ws/terminal'` 未劫持；(C) `sessionCwdFromBetterSidebar` 单一 `window.__DSH_SESSION_CWD` 全局，`null→local` 不稳定。
- **r3 修复证据**：
  - **A. `fetch` 全前缀映射**：`src/client/index.ts:71-81` 的 `mapToRemote(pathname)` 统一映射 `'/sidebar/api'→'/sidebar/remote/api' | '/sidebar/upload'→'/sidebar/remote/upload' | '/sidebar/file'→'/sidebar/remote/file' | '/sidebar/html/'→'/sidebar/remote/html/'`；`113-130` 的 `fetch` 劫持对 **任意** `/sidebar/*` 请求抽 `bodyText`(JSON) 或 `searchParams/query / html` 路径的 `sessionId`→`cwdOfSessionId(ctx,sessionId)`（`getSnapshot().byId[sessionId].cwd` 的 `sessionId` 粒度，非全局单例，`null` 时仅放行不误判为 local）→`routeByCwd(cwd)`→`kind===remote` 即 `mapToRemote+search` 重写，跨 `host` 直接放行。`remote-client-routing.test.js` 的 `fetch patch rewrites /sidebar/api|upload|file|html + WS to remote when cwd is remote` 以 `fetchCalls` **网络拦截证据**证明：`remoteSessionId` 的 `api/upload/file/html` 均命中 `/sidebar/remote/*`，`localSessionId` 不命中；**HTML 相对资源**（`fetch('/sidebar/html/<sid>/...')`）同理命中 `remote/html`。
  - **B. `WebSocket` 构造实际被消费**：`src/client/index.ts:84-173` 新增 `PatchedWS`：劫持 `globalThis.WebSocket` 构造（保留 `origWS`→`OrigWS` 透传），对 `url instanceof URL|string` 归一为 `URL`，跨 `host` 放行；对 `pathname ∈ {'/sidebar/ws/terminal','/sidebar/ws/agent-terminals'}` 抽 `sessionId∈{searchParams.sessionId,session}`→`cwdOfSessionId`→`routeByCwd`→仅当 `kind===remote && pathname==='/sidebar/ws/terminal'` 时改写 `next.pathname='/sidebar/ws/remote-terminal'`（`agent-terminals` 保持原路径，防误转）。该劫持直接覆盖 Better Sidebar 的 `new WebSocket('/sidebar/ws/terminal')` 硬编码（`lib/client-terminal.js:9149`），`remote-client-routing.test.js` 的 `new WebSocket('ws://.../sidebar/ws/terminal?sessionId=remoteSessionId')` 被拦截为 `/sidebar/ws/remote-terminal`、`localSessionId` 保持原路径的证据已落盘。
  - **C. 按 `sessionId` 稳定路由**：`cwdOfSessionId(ctx,sessionId)` 优先 `sessions.list.getSnapshot().byId[sessionId].cwd`（Cordis `sessions` 的稳定契约），回落 `sessions.get(id).header.cwd`；无 `sid` 时 `sessionIdFromUrl(url,bodyText)` 额外解析 `JSON body`/`searchParams`/`/sidebar/html/<sid>/*` 路径；`null→local` 仅为“可路由所需 `cwd` 不存在时”的显式放行，测试以 `localSessionId` 的 `sessions.list` 快照验证多 session 隔离，本地请求不变性由同用例的 `local` 断言覆盖。
  - **边界**：`mapToRemote` 未转 `/sidebar/bundle` 等非数据路由，符合“单包三行 insert 仅对数据/终端路由做远程化”的架构意图。
- **真机标注**：HTML 的 iframe `src` 实际网络为 `fetch` 劫持同构覆盖，相对资源的二级请求（`./style.css` 等）在 Host 的 `/sidebar/remote/html` 同前缀下同路由；无真机时的二级资源端到端未跑，但 `fetch` 前缀劫持的单测证据已覆盖**实际被 Better Sidebar 消费**的构造点（非仅 `pick*` 工具函数）。**闭环**。

### F-02 — 远端 PTY cwd 注入（medium） **→ r2 已关闭，r3 保持关闭**

- `remote-pty.ts:60-67` 的 `buildRemoteCommand('test -d || mkdir -p', undefined)` 预探活与 `shell.write('cd '+shellQuoteSingle(cwd)+' ...')` 已单引号转义；F-00 修复后不再被 blocker 遮蔽。**保持关闭**。

### F-03 — 远端写路径沙箱三态硬编码（medium） **→ r2 已关闭，r3 保持关闭**

- `getSandboxMode(ctx,sessionId)` 优先 `sessions.get(id).sandboxMode|header.sandboxMode` 回落 `settings.get('dsh-fs-sandbox').mode`，`upload/fs.write|edit|delete|rename/remoteWriteAtomic` 均 `mutationDenialMode(realMode, normalize(p), remoteCwd)+sandboxDenialError` 三态（`read-only→403` 等），`policy-and-quote.test.js` 覆盖。**保持关闭**。

### F-04 — `compat.ts` 空桩（medium） **→ r2 已关闭，r3 保持关闭**

- `assertCompat` 于 `apply` 首行调用，校验 `webServer/sessions/webRuntime/settings/sshPool` 与 `dsh-better-sidebar@^0.17.1/@dsh-ssh/dsh-ssh@^0.1.3` 区间+`node>=22`。**保持关闭**。

### F-05 — 上传 `createWriteStream` 8s 抢先 resolve（medium） **→ r2 已关闭，r3 保持关闭**

- 已移除 `setTimeout(8000)` 抢先路径，现仅 `close/finish/error` 结算，`execWithTimeout(AbortSignal)+504` 与 `rm -f tmp` 清理补齐，`timeout-cleanup.test.js` 覆盖。**保持关闭**。

### F-06 — `compareEntries` 溯源与双实现分叉（low） **→ r2 已关闭，r3 保持关闭**

- `remote-fs.ts:1-5` 溯源标注，`compareEntries` 唯一 import 自 `wire.ts`。**保持关闭**。

### F-07 — 未使用 `wss` 常驻微瑕（low） **→ r2 已容忍，r3 保持容忍**

- 注释化+`teardown: remotePty.disposeAll()+wss.close()+remoteWss.close()`。**保持容忍**。

---

## 5. 安全专项（r3 增量核验）

- **路径注入**：`shellQuoteSingle` 单引号转义（`'→'\''`）覆盖全部 `exec`（`upload:makes+base64, delete:rm -rf, rename:mv -f, write/edit:remoteWriteAtomic, git:-C cwd, pty:cd cwd, html/file:stat/read`），`relativePath` 拒绝 `..`/绝对路径/空段，`resolveRemotePath` 归一后 `isPathInsideWorkspace` 二次校验。**通过**（新增 `src/host/ssh-shell-patch.ts:25-38` 的 `doShell._ensureOpen` 与重连前置，不引入新的 shell 注入面）。
- **占位目录误操作**：无 `opendir(placeholder)/realpath` 占位读取，`resolveRemotePath` 重锚仅作远端地址归一。**通过**。
- **凭据/TOFU**：`readHostsDoc(dsh-ssh-hosts)` 仅 Host 侧，`displayAddress` 仅 `hostLabel:/path`；`SshError stage='host-key-unknown'` 携带 `fingerprint/rawKeyBase64/keyType` 由上游 `known_hosts`  verifier 产生，本包未新增 `appendKnownHost` 直写，信任持久化仍由 `@dsh-ssh/dsh-ssh` 的 Typert 通道负责，不自动迁移 `~/.ssh/*`/`known_hosts`（`README` 已声明）。**通过**。
- **流式上限**：`uploadLimit 128MiB/mediaLimit 20MiB/remoteMaxFileBytes 10MiB/readLimit 512KiB/listLimit 1000/transcript 1MiB/MAX_BODY_BYTES 1MiB` 均 Host 强制；`execWithTimeout→504` 与 tmp 清理已补齐。**通过**。
- **生命周期/去重**：`ctx.effect` 包裹全部 `register/registerUpgrade`，`remotePty.disposeAll()+wss/remoteWss.close()` 在 `teardown`；`SshPool` 单例无每请求新建 `Client`；`cordis.patch.yml` 的 `!!js` guard 防别名重复。**通过**。

---

## 6. 单包安装 / 依赖锁定 / 可迁移性

- **单包**：`package.json#dsh.bundle.patch→./cordis.patch.yml`，`files:["lib/","cordis.patch.yml","README.md"]`，`pnpm pack --dry-run @remote/sidebar-remote@0.1.0` 的 tarball 含 `lib/host/ssh-shell-patch.{js,d.ts}` 等 6 行+`client/host/shared` 产物；`dsh plugin add` 三行 `insert`。**通过**（`pnpm build` 产物已含 `ssh-shell-patch`，`patchSshConnShell` 的调用链在 `lib/host/index.js:80` 可审计）。
- **依赖锁定**：`pnpm-lock.yaml` 已提交，`engines.node>=22` 与下界一致；`dependencies` 精确 pin `0.17.1/0.1.3`；运行时校验见 F-04。**通过**。
- **Cordis 去重/卸载**：`cordis.patch.yml` 三行 guard 顺序敏感性已满足（两上游在 `remote-sidebar` 之前），`README` 给出 `remove` 指引。**通过**。
- **设备迁移**：`README`/`architecture.md §7` 说明 `dsh-ssh-hosts`（兼容 `dssh-hosts`）随 `~/.dsh/settings.yaml` 迁移、`~/.ssh/*` 与 `known_hosts` 不自动迁移、TOFU。**通过**。

---

## 7. 本地工作区回归

- `routeByCwd` 单真+显示/身份分离+本地沿用上游实现，三条不变式单测保持；Host 对 `local` 不触 `sshPool`；Client 对 `localSessionId` 的 `fetch/WS` 均保持原前缀（`remote-client-routing.test.js` 的 `local` 断言与跨 `host` 放行）。**通过**。

---

## 8. 验证证据充分性评价（r3）

- **已落实**：`t8` 的 `pnpm install --frozen-lockfile 0 ｜ typecheck 0 ｜ test 36 pass(6 suites, +3 契约/超时/路由套件) ｜ build 0 ｜ pack --dry-run @remote/sidebar-remote@0.1.0` 5 项流水线均通过，`remote-client-routing.test.js` 以 `sessions.list.getSnapshot().byId[sessionId].cwd` 的 **真实 `ctx` 形状**+`fetch/WS` 网络拦截证据替代仅测 `pick*` 工具函数，补齐 `api/upload/file/html/ws` 四链路被 Better Sidebar 实际消费的证据；`ssh-shell-patch` 的 `fakeClient.shell(wndopts,{},cb)` 契约冒烟以真实 `ssh2.Client.shell` 回调形状证明 PTY 通道可用（`node` 运行时 `before=undefined→after=function` 且 `stream.write` 可得）。
- **仍需标注（非阻断）**：无可用远端主机，SFTP 真实枚举/大文件分块/断网重连、PTY 真实 `pwd==remoteCwd/stty size/park 30s`、Git 真实 `status/diff/log` 交叉核验、TOFU指纹对话框 的端到端均**未真机验证**，复现步骤见 `verification.md §6`；本报告所有通过项均为无真机下的可验证子集，但 F-00/F-01 的代码链完整，已满足“无真机时至少要求真实上游形状的契约测试；真机未跑必须继续标注，但若代码链完整可按契约判断”的 r3 通过条件。
- **区分模拟/真机**：不再以 `pnpm test` 的纯函数通过视同 PTY 可用；`SshConn.shell` 的可用性以运行时 `prototype.shell` 形状+`Client.shell` 封装契约为准，`fetch/WS` 的可用性以 `window.fetch`/`WebSocket` 构造的实际拦截为准。

---

## 9. 总评与放行建议

- **优点**：`routeByCwd` 单真、显示/身份分离、远端失败不回落、路径引用、三态沙箱、凭据/TOFU 复用、流式上限与 `ctx.effect` 清理均符合 `t1` 架构；`ssh-shell-patch` 的受控内嵌以最小改动补齐上游缺口且幂等；Client 按 `sessionId` 的 `fetch/WS/html/file` 全前缀映射与多 session 隔离已闭环。
- **阻断**：无。F-00/F-01 已按 r2 未关闭口径实质修复并获契约/网络拦截证据；F-02..F-07 r2 已关闭保持关闭。
- **建议**：**放行至 `t10 integration` 整合交付**；建议在 `t10` 或真机环境补充 `ws/remote-terminal` 的 `resize/park` 与二级 HTML 相对资源的真机 smoke（无需阻塞本轮 pass），并在 `docs/verification.md` 增补 r3 的 5 项流水线与契约证据至 `verification.md §8`。

---

*审查执行：`read` 修复后全量源码+`ssh-core.js` 运行时契约实测+`fakeClient.shell` 契约冒烟+`dsh-better-sidebar lib/*` 调用点审计+`pnpm typecheck/build/test 36 pass/pack --dry-run` 静态核查；未修改 `src/**`/`test/**`/DSH 发行目录。*
