# 远程侧边栏聚合插件 — 架构契约（t1）

> **状态**：需求确认 / t1 交付件 · 目标版本：`remote-sidebar-plugin@0.1.0`  
> **上游锁定**：`dsh-better-sidebar@0.17.1`、`@dsh-ssh/dsh-ssh@0.1.3`、DSH `0.1.1-rc.2`（Cordis `^4.0.1`）

本文件是后续 `t2` 唯一可执行依据；与 `compatibility.md` 共同满足 `t1` 的四项验收。

---

## 1. 目标与非目标

**目标**：开发一个可独立安装、可迁移的单一 DSH Web 聚合插件，自动集成 `dsh-better-sidebar` 与 `@dsh-ssh/dsh-ssh`，使**文件树 / 浏览 / 读取 / 编辑 / 保存 / 上传 / 下载 / 预览 / 终端 / Git** 在 **SSH 远程工作区** 中真正运行于远程主机；**本地工作区**保持原有侧边栏行为**不变**。

**非目标**（本阶段禁止）：

- 部署或发布 npm 包、`dsh plugin add` 到用户现运行实例、修改 `~/.dsh` 下已安装 profile 或 DSH 发行目录（`$(npm prefix -g)/lib/node_modules/@deepseek-ai/dsh`）。
- 修改已发布的 `dsh-better-sidebar` / `@dsh-ssh/dsh-ssh` 源码；仅通过公开接口、适配层或**受控内嵌**方式集成。
- 自动迁移私钥、密码、`known_hosts` 等敏感凭据文件。

---

## 2. 实现路径决策

### 2.1 三选一评估

| 路径 | 含义 | 评估 |
|------|------|------|
| **A. 上游扩展** | 向两上游仓库提交 PR，新增 provider/hook 扩展点，让聚合插件以纯扩展方式挂载 | 最干净、可长期维护。**当前不可用**：`dsh-better-sidebar@0.17.1` 未暴露 `fsProvider`/`ptyProvider`/`gitProvider` 等可替换契约；`@dsh-ssh/dsh-ssh@0.1.3` 的 `SshPool`/`ExecFs`/`Sftp` 能力仅供其路由工具使用，未暴露给侧边栏消费。等待上游发布不可控，阻塞交付。 |
| **B. 纯适配层（wrapper）** | 聚合插件仅声明依赖、拦截 `/sidebar/*` 请求并在 Host 侧按 `routeByCwd` 分发到本地或远端实现，Client 侧复用现有 `api` / 视图 | 依赖两上游保持 Host 可调用的内部函数稳定，但 `dsh-better-sidebar` 的 `fs-tree.ts`/`fs-operations.ts`/`git.ts`/`pty-manager.ts` 均未导出为可注入 Service，运行时无法在不拷贝逻辑的情况下接管。**单纯代理不可完整覆盖**传输、预览、终端、Git 的远程语义。 |
| **C. 受控内嵌（approved） — 选定方案** | 聚合插件以 **单一 npm 包** 形式，**依赖**两上游的已发布包获得 `cordis.patch.yml` 的自动挂载与类型定义，同时在 Host 侧**受控内嵌**必要的远端执行分支（基于 `@dsh-ssh/dsh-ssh` 的 `sshPool` / `router` / `policy` 与 `dsh-better-sidebar` 的纯函数如 `mediaTypeForPath` / `html-route` / `wire` 的等价实现），并在 Client 侧复用/扩展现有视图与 `api` 契约。内嵌部分显式标注来源文件与版本，接受上游变更时的合并成本，换取**可独立交付**与**完整远程语义**。 | **选定**。满足“可独立安装、单包迁移”的硬约束；内嵌范围受限、可审计；向上游扩展演进时可逐步收敛为 B。 |

> **契约**：`t2` 必须按 C 实现；若实现中发现某个远程语义可完全委托给上游公开 Service 而无需内嵌，应优先委托，并在 `docs/compatibility.md` 中记录偏差。

### 2.2 包形态与安装迁移机制

```
remote-sidebar-plugin/
  package.json          # name: @<scope>/remote-sidebar-plugin, version 0.1.0
                        # dependencies: dsh-better-sidebar@0.17.1, @dsh-ssh/dsh-ssh@0.1.3, ssh2, diff, ...
                        # dsh.bundle.patch -> ./cordis.patch.yml
  cordis.patch.yml      # insert 三行（带去重 guard）：
                        #  - id: better-sidebar      name: dsh-better-sidebar
                        #  - id: '@dsh-ssh/dsh-ssh'  name: '@dsh-ssh/dsh-ssh'
                        #  - id: remote-sidebar      name: <this package>
  lib/**                # tsc 产物（ESM）
  src/**                # Host + Client 源码
```

- **单次安装**：用户执行一次 `dsh plugin --profile <name> add <path-or-pkg>`（或 `dsh plugin add @scope/remote-sidebar-plugin` 发布后）即可；`bundle.patch` 的 `insert` 按序挂载，`disabled: !!js` 表达式避免与用户已手动挂载的两插件重复（与 `dsh-better-sidebar` 现有 guard 语义一致，聚合包的 guard 需探测两种 `name`）。
- **版本锁定**：`package.json` 精确依赖 `0.17.1` / `0.1.3`，`pnpm-lock.yaml` 提交；`src/compat.ts` 在 `apply()` 启动时校验 `peerDependencies` 与运行时 `ctx` 中 `dshSettings`/`dshTools` 等 Service 版本，不满足则抛出带修复指引的 `apply` 错误而非静默降级。
- **迁移**：`~/.dsh/settings.yaml` 中 `dsh-ssh-hosts`（及兼容的 `dssh-hosts`）与 `dsh-better-sidebar` 偏好命名空间随用户主目录迁移；插件不复制私钥/密码/`known_hosts`，文档仅说明需手动复制或重建，见 §7。

---

## 3. 本地 / 远程判定与路径身份

### 3.1 判定（唯一真相）

复用 `@dsh-ssh/dsh-ssh` 的 `src/router.ts`（纯函数、零依赖）：

- `remoteRoot(env)`：`DSH_SSH_REMOTE_ROOT` > `$DSH_HOME/remote` > `~/.dsh/remote`。
- `isValidHostId`、`encodeRemotePath` / `decodeRemotePath`（base64url、单段、防歧义）、`mapLocalToRemote(localPath)`（要求恰好两段 `<hostId>/<encoded>` 且解码后为以 `/` 起始的绝对路径）、`mapRemoteToLocal`、`routeByCwd(cwd)`。
- `resolveRemotePath(requestedPath, remoteCwd, placeholderCwd)`：相对路径基于 `remoteCwd`；落在占位目录内的绝对路径重锚回远端；其余绝对路径按远端绝对路径直通，`posix.normalize` 做词法归一。

Host 侧每次处理 `/sidebar/*` 请求时，以 **session header 的 `cwd`**（`ctx.sessions` / `ctx.webServer` 注入的会话上下文）为输入调用 `routeByCwd`；Client 侧以 `SessionScope.cwd` 为提示，仅用于在首帧水合前的乐观判断，最终以 Host 判定为准。

### 3.2 路径身份与显示分离

- **内部身份**：远端文件一律以 **POSIX 绝对路径**（`posix.resolve`/`posix.normalize` 结果）作为唯一标识，经 `resolveRemotePath` 归一后传入 `SshConn.exec` / `Sftp` / `git -C`。
- **显示文本**：地址栏/标题显示为 `"<hostLabel>:/remote/path"`，其中 `hostLabel = hosts[hostId].name || hostId`，仅用于展示。**禁止**将显示文本反解析为身份；所有内部流转携带结构化 `{ hostId, remotePath }`。
- **可读地址**（验收项）：任意远端会话的地址栏首行必须呈现 `服务器名:/远程路径`（例 `prod-gpu:/home/alice/proj`），而本地会话显示本地绝对路径。

### 3.3 工作区边界

- 本地：复用 `dsh-better-sidebar` 的 `path-security.ts`（`realpath` + `isWithin`）作为本地分支的 containment。
- 远端：词法 `isPathInsideWorkspace(target, remoteCwd)`（见 `@dsh-ssh/dsh-ssh/src/policy.ts`，`posix.normalize` + `root + '/'` 前缀判断，`/` 根允许全部），并在 `write`/`edit`/`bash` 前做沙箱模式判定（§6）。

---

## 4. 功能路由契约

> **不变式**：`kind === 'remote'` 的会话，**每一个**远端语义必须经 SSH 通道；`kind === 'local'` 的会话必须沿用原 `dsh-better-sidebar` 的本地实现；**远端失败不得回落到本地占位目录**（占位目录仅为 `routeByCwd` 的路由标记，不含用户数据）。

### 4.1 文件树 / 浏览

- 远端分支：`SshConn.sftp().readdir`（或 `ExecFs` 回退）枚举一级目录，构造与 `fs-tree.ts` 相同的 `FsEntry` 形状：`{ name, path: posix.join(remoteCwd, name), isDir, isSymlink, broken, hidden }`，`hidden = name.startsWith('.')`；对 `isSymlink` 行并发 `stat` 探测（并发度 32，上限与本地一致），`broken = stat 失败`，`isDir` 取目标类型；按 `compareEntries`（目录优先、大小写不敏感）排序，`truncated` 按 `listLimit`（默认 1000）标记。
- 本地分支：直接委托 `dsh-better-sidebar` 的 `listDirectory`。
- **禁止回落**：远端 `readdir` 抛 `SshError` 时向 Client 返回 `code: 'fs-error' | 'sftp-unavailable'` 等远端错误，不尝试 `opendir(placeholderPath)`。

### 4.2 读取 / 编辑 / 保存

- `fs.read`（Host `/sidebar/api/fs.read`）：远端经 `Sftp.stat` + `Sftp.readText`（或 `exec cat | base64` 回退，`remoteMaxFileBytes` 10 MiB 限）取内容，本地 `buildWindow` 分窗（`readLimit` 2000 行 / `readMaxLineLength` 2000 / `readMaxBytes` 50 KiB）与本地一致；二进制大文件返回 `{ kind:'binary', size, head }`，由 `/sidebar/file` 媒体路由按需流式传输。
- `fs.write` / `fs-edit`（`fs.write` / `fs.edit`）：远端先 `readText` 取 `before`，本地执行 `applyLiteralEdit` 语义（含 LF 归一、`replace_all` 唯一性校验），再 `Sftp.writeFileAtomic`（临时同目录文件 + `rename`）回写；远端路径经 `resolveRemotePath` + `mutationDenialMode` 校验。
- 错误：远端 `ENOENT`/`EACCES`/沙箱拒绝均以 `SidebarError` / `FsError` 的 `code` 原样透出，不映射为本地 `fs-error` 的占位路径。

### 4.3 上传 / 下载

- **上传**（`POST /sidebar/upload?sessionId=&dir=&relativePath=`）：远端分支流式写入 `Sftp.createWriteStream(tmp)`，`uploadLimit`（默认 128 MiB）超限直接拒绝，临时文件失败清理；`relativePath` 校验与 `fs-operations.ts` 一致（拒绝绝对路径、`..`、空段）；目标父目录按需 `mkdir -p`。
- **下载 / 媒体**（`GET /sidebar/file?sessionId=&path=&download=`）：远端经 `Sftp.createReadStream` 或 `execStream` 流式管道，`mediaLimit`（默认 20 MiB）超限拒绝，`Content-Type` 复用 `mediaTypeForPath`，`download=1` 附加 `Content-Disposition: attachment`。
- 流式上限、并发与取消信号（`AbortSignal`）与本地一致。

### 4.4 预览（HTML 相对资源）

- 复用 `html-route.ts` 的 `encodeHtmlUrl` / `decodeHtmlUrl`（路径段 `encodeURIComponent`，UNC 以 `//` 标记，`sessionId` 前缀保证相对解析留在同路由）。
- 远端分支：HTML 主文档与同路由下的相对资源（`./style.css`、`img/x.png`）均经远端 `Sftp.readFile` / `mediaTypeForPath` 提供；MIME 与 `mediaLimit` 同上。
- 本地分支：沿用原 `registerHtmlRoute` 行为。

### 4.5 终端（PTY）

- **远端**：不使用本地 `node-pty`。经 `SshPool.acquire(hostCfg)` 取得 `SshConn`，以 SSH `shell` 通道分配 PTY（`pty: { term: 'xterm-256color', cols, rows }`），`buildRemoteCommand(cmd, remoteCwd)` 确保从真实 `remoteCwd` 启动；`cols/rows`、`SIGINT`/`SIGTERM`、重连优雅期等语义与 `PtyManager` 对齐（`reconnectGraceMs` 30s、`maxPerSession` 3、transcript 上限 1 MiB、park 语义）。
- **本地**：复用 `PtyManager` + `node-pty`。
- **WebSocket**：沿用 `/sidebar/ws/terminal` 与 `/sidebar/ws/agent-terminals` 的帧协议（`open`/`input`/`resize`/`close`/`park`），远端仅替换 PTY 后端，不改变线协议。

### 4.6 Git

- 远端：全部经 `SshConn.exec` 在 `remoteCwd`（或 `worktree`）上执行 `git` 二进制，参数与本地 `git.ts` 完全一致：`git -C <cwd> --no-pager -c color.ui=false <subcommand>`，`--porcelain=v1 -z` / `worktree list --porcelain -z` / `log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D` 等；解析函数 `parsePorcelainZ` / `parseWorktreeList` / `parseLogLines` 复用。
- `repoRoots` / `repoRoot` / `isGitRepo` / `currentBranch` 的发现逻辑远端化（`exec` 而非 `readdir` + 本地 `spawn`），缓存与并发去重保留。
- 本地：直接委托原 `git.ts` 的 `spawn` 路径。

---

## 5. 断线与错误模型

### 5.1 断线行为

- **SSH 连接**：`SshConn` 的 `close`/`end`/`error` 标记 `dead`，下一次 `exec`/`sftp` 透明单次重连（重建 `Client`）；重连失败则向 Client 返回 `SshError{ stage, hostId, message, fingerprint? }`，UI 展示“已断开 / 重连失败”横幅，不自动回落到占位目录。
- **WebSocket / 终端**：沿用 `PtyManager` 的 `park` / `reconnectGraceMs` / `pendingCloses` 语义；远端 PTY 的 `close` 帧同样触发远端 shell 的 `close`。
- **占位清理**：复用 `@dsh-ssh/dsh-ssh` 的 `installPlaceholderCleanup`（监听 `domain/changed` `workspace.workspaces` 的 `deleted` 事件，按 `placeholderRoot` 清理本地空占位目录），失败静默。

### 5.2 错误码与 HTTP 映射

沿用 `dsh-better-sidebar` 的 `SidebarError` + `writeError` 信封（`{ ok:false, error:{ code, message } }`）：

| 场景 | code | status | 说明 |
|------|------|--------|------|
| 路径非绝对 / 解析失败 | `fs-error` | 400 | `requireAbsolute` / `realpath` 失败 |
| 越权（本地 `isWithin` / 远端 `isPathInsideWorkspace`） | `forbidden` | 403 | 含沙箱 `read-only` / `workspace-write` 拒绝 |
| 未知工作区 / 会话不存在 | `not-found` | 404 | `mapLocalToRemote` 非法或 `hostId` 未配置 |
| 未知远端主机配置 | `fs-error` + 提示 `not configured in dsh-ssh-hosts` | 400 | `getHostConfig` 缺失 |
| 上传超限 | `too-large` | 413 | `uploadLimit` / `mediaLimit` |
| `known_hosts` 不可读 / Host key 未知/不匹配 | 对应 `SshError.stage`（`known-hosts`/`host-key-unknown`/`verify-host-key`） | 400/403 | 透出 `fingerprint`/`rawKeyBase64`/`keyType` 供 TOFU 对话框 |
| Git 非仓库 / 命令失败 | `not-repo` / `git-error` | 400/500 | `GitCommandError` 原样透出 |
| 远端执行超时 | `exec-timeout` | 504 | `SshConn.exec` 的 `timeoutMs` |
| 输出超限 | `exec-output-overflow` | 413 | `maxStdoutBytes` / `remoteMaxFileBytes` |

> **关键不变式**：远端 `code` **不得**被 Client 解释为“重试本地”；Client 侧的 `api` 聚合层在 `kind === 'remote'` 时收到任何 `ok:false` 即展示远端错误，不触发本地 `call`。

---

## 6. 安全边界

### 6.1 信任边界

- **浏览器信任围栏**：所有 `/sidebar/*` 路由复用 `trust-fence.ts` 的 `isTrustedApiRequest`（Host 必须为 loopback 或 `trustedHosts`，`Sec-Fetch-Site: cross-site` 拒绝，`Origin` 主机名一致性校验），与 `dsh-better-sidebar` 一致。
- **DNS 重绑定**：同上，`trustedHosts` 来自 `webRuntime` / `--trusted-host`。
- **非安全边界**：与 `dsh-fs-sandbox` 一致，路径 containment 为“防误用”而非对抗性沙箱；符号链接/TOCTOU 残余按上游威胁模型接受。

### 6.2 沙箱与路径安全

- **本地**：参数化 `fs` / `shell` 的 `sandboxMode`，`policy.ts` 的 `isPathInsideWorkspace` + `mutationDenialMode` 在 `write`/`edit`/`bash` 前判定，拒绝形状为 `FsError('FS_SANDBOX_DENIED', '[sandbox: ...]\n[escalation hint]')`，与官方 `dsh-tool-fs` 一致；`escalation` 仅在非 `remoteRouting` 时暴露 `sandbox_permissions`/`justification`。
- **远端**：由于远端无本地沙箱执行器，`remoteRouting=true` 时 `escalationModes=[]`，`sandbox_permissions` 不进入 schema；但**三态拒绝语义**仍执行（`danger-full-access` 放行 / `workspace-write` 要求 `isPathInsideWorkspace` / `read-only` 拒绝所有写），与 `@dsh-ssh/dsh-ssh/src/policy.ts` 一致。
- **路径注入**：所有远端命令经 `shellQuoteSingle` 单引号转义（`'` → `'\''`）与 `buildRemoteCommand("cd '<cwd>' && <cmd>")` 组合；`relativePath` 拒绝 `..` / 绝对路径 / 空段。

### 6.3 凭据与 secrets

- `HostConfig.auth.password` 为 `schemastery` `role: 'secret'` + write-only 语义（`hosts` 为 dict，`mergeLayers` 递归合并，空白 `password` 保持已存值）；聚合插件不新增 `password` 存储，仅消费 `@dsh-ssh/dsh-ssh` 的 `readHostsDoc` / `getHostConfig`。
- 私钥路径经 `expandHome` 展开，仅在发起 `SshConn` 时 `readFile`，不回传前端。
- `known_hosts` 默认 `~/.ssh/known_hosts`，`checkHostKey` / `verifyHostKey` / `appendKnownHost` 的 TOFU 流程与 `ssh-core.ts` 一致；`unknown` 时返回 `fingerprint`/`rawKeyBase64`/`keyType` 供前端对话框确认后 `trustHostKey` 追加。
- **不自动迁移**：私钥文件、口令、`known_hosts` 不随插件包迁移；`docs` 仅说明“在新设备上重建 `dsh-ssh-hosts` 或复制 `~/.ssh` 与 `settings.yaml` 的对应段”。

---

## 7. 配置与凭据迁移策略

| 配置 | 位置 | 迁移方式 |
|------|------|----------|
| SSH 主机（`dsh-ssh-hosts`，兼容 `dssh-hosts`） | `~/.dsh/settings.yaml` 的 `hosts` dict | 随 `~/.dsh` 迁移；新设备上通过设置页重建或复制该 YAML 段 |
| 侧边栏偏好（`dsh-better-sidebar` namespace） | 同 `settings.yaml` | 同上，随 `~/.dsh` 迁移 |
| 私钥文件 | `~/.ssh/id_*` 等本机路径 | **不自动迁移**；用户自行 `scp`/U 盘复制并保持权限 600 |
| `known_hosts` | `~/.ssh/known_hosts` | **不自动迁移**；首次连接走 TOFU 对话框重新信任 |
| 插件包 | `node_modules/@scope/remote-sidebar-plugin` + `cordis.patch.yml` | 单包 `dsh plugin add` 或复制 `pnpm-lock.yaml` 后 `pnpm install` |

卸载：`dsh plugin --profile <name> remove <pkg>` 移除 `bundle` 行；聚合插件的 `ctx.effect` 清理所有 `register`/`registerUpgrade`/`on('agent/created')`/`settings.register` 的 disposer；`placeholderRoot` 下的空占位目录由 `@dsh-ssh/dsh-ssh` 的 `installPlaceholderCleanup` 在工作区删除时回收。

---

## 8. 兼容性与版本锁定（摘要，详见 `compatibility.md`）

- **DSH**：`0.1.1-rc.2`（Cordis `4.0.1`、`@deepseek-ai/dsh-settings` / `dsh-tools` / `dsh-agent` / `dsh-host-webserver` 等 `^0.1.0-rc.6` 以上）；`apply(ctx, config)` 的 `inject` 声明 `['settings','webServer','sessions']` 等，不满足时进入 Cordis waiting 而非崩溃。
- **上游精确版本**：`dsh-better-sidebar@0.17.1`（`lib/index.js` 含 `Schemastery` 的 `Config` / `PrefsSchema`，`lib/types/**` 完整）、`@dsh-ssh/dsh-ssh@0.1.3`（`src/router` / `src/ssh-core` / `tools` 的 ESM 形态）。
- **公开 vs 非公开接口**：公开（`@dsh-ssh/dsh-ssh` 的 `sshPool` Service / `router` / `SshError` / `HOST_KEY_UNKNOWN_STAGE`；`dsh-better-sidebar` 的 `mediaTypeForPath`/`html-route`/`wire`/`path-security` 的纯函数语义）为首选依赖；非公开（`fs-tree`/`pty-manager`/`git` 的内部实现）通过**受控内嵌**消化，并在 `compatibility.md §3` 逐项标注差距与升级策略。
- **Node**：`>=22`（`@dsh-ssh/dsh-ssh` 的 `engines` 要求，`ssh2` 的 `keepalive` 等）。

---

## 9. 可测试的验收矩阵

### 9.1 功能验收（t3/t4 的自动化或可复现实证）

| # | 场景 | 判定 | 远程语义 | 本地回归 |
|---|------|------|----------|----------|
| F1 | 远端文件树 | `routeByCwd → remote` 时 `fs.tree` 经 SFTP 枚举，排序/隐藏/符号链接/broken 与本地一致 | SFTP `readdir` + `stat` 探测 | 本地 `opendir` 不变 |
| F2 | 远端读取 | `fs.read` 返回远端内容，`buildWindow` 分窗与截断一致 | `Sftp.readText` + `readLimit` | 本地 `readFile` 不变 |
| F3 | 远端编辑保存 | `edit` 语义 LF 归一、唯一性校验、原子 `rename` | `readText` → `applyLiteralEdit` → `writeFileAtomic` | 本地同语义 |
| F4 | 远端上传/下载 | 流式、限 `uploadLimit`/`mediaLimit`、失败清理 | `Sftp.createWriteStream` / `createReadStream` | 本地 `createWriteStream` 不变 |
| F5 | HTML 预览相对资源 | `encodeHtmlUrl` 相对解析留在 `/sidebar/html`，远端资源可加载 | 远端 `Sftp.readFile` | 本地 `readFile` 不变 |
| F6 | 远端终端 | SSH PTY 从真实 `remoteCwd` 启动，`cols/rows`/信号/重连一致 | `SshConn shell` PTY | 本地 `node-pty` 不变 |
| F7 | 远端 Git | `status/diff/log/commit` 等在远端 `git` 执行，`porcelain -z` 解析一致 | `SshConn.exec git -C <remoteCwd>` | 本地 `spawn git` 不变 |
| F8 | 可读地址显示 | 远端地址栏为 `hostLabel:/remote/path`，本地为本地绝对路径 | 展示层 | 展示层 |

### 9.2 不变式与负向验收

| # | 不变式 | 验证方式 |
|---|--------|----------|
| N1 | **远端失败不回落本地**：任意远端 `fs/pty/git` 错误不触发 `opendir(placeholderRoot)` / 本地 `spawn` | 故障注入：`SshPool.acquire` 抛 `SshError` 时断言无本地 FS 调用 |
| N2 | **本地零回归**：`kind===local` 时无 SSH 连接、无远端命令 | `routeByCwd → local` 时 `sshPool.acquire` 零调用 |
| N3 | 路径穿越拒绝 | `relativePath` 含 `..` / 绝对路径 → `bad-request`；`isPathInsideWorkspace` 越权 → `FS_SANDBOX_DENIED` |
| N4 | 地址显示不参与路由 | 修改显示文本不改变 `resolveRemotePath` 结果 |
| N5 | 断线可恢复且不丢路由 | `SshConn` `dead` 后单次重连成功；失败则显式错误 |

### 9.3 非功能验收

- **单包安装**：`pnpm pack --dry-run` 包含 `lib/**`、`cordis.patch.yml`、`package.json`，`pnpm install --frozen-lockfile` 可复现；`dsh plugin add` 单次挂载三行且去重。
- **可逆生命周期**：`ctx.effect` 返回的 disposer 覆盖所有 `register`/`registerUpgrade`/`on`/`settings.register`，`cordis_stop` / `remove` 后无残留监听或 PTY。
- **可移植**：`pnpm-lock.yaml` 提交，`engines.node >=22` 声明，`~/.dsh` 迁移说明完整。

---

## 10. 对 t2 的约束

1. 禁止修改 `dsh-better-sidebar` / `@dsh-ssh/dsh-ssh` 的已发布产物与 DSH 发行目录。
2. 禁止部署/发布；`t2` 的验证仅在本地 `pnpm` 范围内（`install`/`typecheck`/`test`/`build`/`pack --dry-run`）。
3. 远端分支的 `SshError` / `SidebarError` / `GitCommandError` 必须保留 `stage`/`code`/`hostId` 等结构化字段，供上层与前端区分展示。
4. 终端与 Git 的远端化必须通过 `SshPool`（连接池）而非每请求新建 `Client`。
5. 所有新增的 Host 路由必须复用 `trust-fence`，Client `fetch` 保持 `content-type: application/json` + `SidebarApiError` 信封。
