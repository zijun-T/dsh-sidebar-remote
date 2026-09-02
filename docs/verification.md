# 验证报告 — t3

> 独立验证（architect, t3 attempt 8e2f71cb）。**未修改** `src/**` / `test/**` / DSH 发行目录；所有命令于本仓库真实执行，失败未被掩盖。

> **关于包名**。本包在 0.2.0 从 `@remote/sidebar-remote` 改名为 `dsh-sidebar-remote`（传导面与验证证据见 `delivery.md §6`）。下面 §1–§9 是当时真实跑过的审计快照，其中的旧包名、旧 tarball 文件名、旧测试计数均**有意保留**，改写它们等于伪造记录。属于可复用操作指引的处所（如 §9.4 的 `curl` 命令、§10.4 的当前产物表）已更新为新名。

> **关于脱敏**。本仓库公开前，文档与测试 fixture 里的真实基础设施信息已替换为占位值：远程主机别名 / IP / 端口 / 用户名 / 家目录、`~/.dsh/settings.yaml` 里的真实 host id、构建机家目录，以及暴露研究工作流的文件名（含一处项目代号）。替换映射**刻意不记录** —— 记下映射等于没脱敏。
>
> 因此下面的终端转写是**结构忠实但非逐字节原文**：命令、退出状态、目录关系与判定逻辑均未改动，只有主机名、路径与文件名被替换。占位值取 RFC 5737 文档专用网段（`198.51.100.0/24`）与明显合成的 UUID，不会撞上任何真实主机。测试 fixture 同样全部合成，脱敏后 **79 pass / 0 fail** 未变。

---

## 1. 验证命令（t2.verify）

| 命令 | 退出码 | 结果 | 证据 |
|------|--------|------|------|
| `pnpm install --frozen-lockfile` | 0 | passed | Already up to date · `pnpm v11.25.0` · 249ms |
| `pnpm typecheck` (`tsc --noEmit`) | 0 | passed | 0 errors |
| `pnpm test` (`node --test test/*.test.js`) | 0 | passed | 21 pass / 0 fail / 3 suites / 86ms |
| `pnpm build` (`tsc -p tsconfig.json`) | 0 | passed | emits `lib/{shared/{router,wire},host/{index,compat,remote-fs,remote-git,remote-pty},client{, /index}}.js` + `.d.ts` |
| `pnpm pack --dry-run` | 0 | passed | tarball `@remote/sidebar-remote@0.1.0` · 23 files · 19.5 kB packed / 72.7 kB unpacked · `remote-sidebar-remote-0.1.0.tgz` |

全部五项通过。

---

## 2. 自动化验证（不依赖真机 SSH）

### 2.1 路由与身份（`test/router.test.js`, 7 tests）

- `routeByCwd('/home/build/proj') → local`。
- `encodeRemotePath('/home/alice/proj')` ↔ `decodeRemotePath` 回环；`decodeRemotePath('!!!') → null`（非规范输入拒绝）。
- `mapRemoteToLocal('myhost','/home/alice/proj')` ↔ `mapLocalToRemote` 回环（`hostId` / `remotePath` 精确一致）。
- `resolveRemotePath('./a','/home/alice','/tmp/placeholder') → /home/alice/a`；`resolveRemotePath('/etc/hosts',…) → /etc/hosts`。
- `displayAddress(localPlaceholder, {srv1:{name:'My Server'}}) → 'My Server:/home/alice/proj'`；`displayAddress('/tmp/local',{}) → '/tmp/local'`。
- **显示与身份分离**：`displayAddress` 的输出不被反解析为路由输入；`mapLocalToRemote(local)` 仍为 `/a/b`。

### 2.2 围栏与路径安全（`test/wire.test.js`, 7 tests）

- `SidebarError` 携带 `code`。
- `isTrustedApiRequest({host:'127.0.0.1:3080'},[]) → true`；`sec-fetch-site: cross-site → false`。
- `encodeHtmlUrl`/`decodeHtmlUrl` 回环（`S1:/a/b/c.html`）。
- `isPathInsideWorkspace('/a/b/c','/a/b') → true`；`/a/other → false`；`/any` 在 `/` 时 `true`（根放行）。
- `mutationDenialMode('workspace-write','/ws/a','/ws') → null`；`'/other' → 'workspace-write'`；`'read-only' → 'read-only'`；`'danger-full-access' → null`。
- `relativePath='..'` 的 `..` 段被识别为穿越（`segs.some(p=>'..')`）。

### 2.3 远端分支纯函数（`test/remote-branch.test.js`, 7 tests）

- `applyLiteralEdit('hello world',{old_string:'world',new_string:'there'}) → 'hello there'`。
- 重复 `old_string` 无 `replace_all` 时抛（唯一性校验）；`replace_all:true` 时全量替换。
- `parsePorcelainZ(' M src/a.ts\0?? new.ts\0')` / `parseWorktreeList` / `parseLogLines` 解析正确。
- 占位不变式单测：`mapRemoteToLocal('h1','/remote/ws') → /home/build/.dsh/remote/h1/<enc> → routeByCwd → remote`；该 invariant 是后续“远端失败不回落”故障注入的基座。

### 2.4 补充手工核验（本机 `node -e`，写入证据见下）

- `isPathInsideWorkspace('/ws/sub/../etc/passwd','/ws')` 的词法归一：经 `posix.normalize` 后 `/ws/sub/../etc/passwd → /ws/etc/passwd` 仍在 `/ws` 内（归一后仍在 workspace 即放行，符合“词法 containment 非安全边界”威胁模型）；`/ws/a/../../etc` → `/etc` 不在 `/ws` 内 → `false`。
- `resolveRemotePath('../../etc','/remote/ws', localPlaceholder) → /etc`（`posix.resolve` 归一后越权，但后续 `mutationDenialMode` + `isPathInsideWorkspace` 在 `remoteWriteAtomic`/`dispatchRemote` 中二次拒绝）。
- HTML 路径穿越：`decodeHtmlUrl('/sidebar/html/S1/ws/../etc/passwd') → {path:'/ws/../etc/passwd'}` 解码成功但**不**直接访问本地文件，后续远端 `resolveRemotePath` + containment 会归一并拒绝。

---

## 3. 单包携带验证

- `pnpm pack --dry-run` 输出的 tarball 包含：
  `cordis.patch.yml`、`lib/client{.js,.d.ts, /index.js}`、`lib/host/{index,compat,remote-fs,remote-git,remote-pty}.*`、`lib/shared/{router,wire}.*`、`lib/index.*`、`package.json`、`README.md`。
- `package.json#dsh.bundle.patch` 指向 `./cordis.patch.yml`；`files` 仅含 `lib/`/`cordis.patch.yml`/`README.md`（不泄漏 `src/`/`test/`/`pnpm-lock.yaml`）。
- `cordis.patch.yml` 三行 `insert`：`better-sidebar:dsh-better-sidebar`（guard 防 `web-ui-better-sidebar` 等别名重复）、`@dsh-ssh/dsh-ssh`（同类 guard）、`remote-sidebar:@remote/sidebar-remote`。

---

## 4. 额外核查项（t3 合同要求的额外检查）

| 项 | 状态 | 说明 |
|----|------|------|
| 远程失败不回落本地 | ✅ 自动化覆盖（基座） | `routeByCwd→remote` 的会话，`resolveRemoteConn` 抛 `SidebarError`（`SshError.stage` → `fs-error`）后 `dispatchRemote` 不触及 `opendir(placeholder)`/`spawn git`；`test/remote-branch` 固定路由不变式，`src/host/index.ts:resolveRemoteConn` 仅走 `sshPool.acquire` |
| 本地零回归 | ✅ 自动化覆盖 | `routeByCwd→local` 时 `src/host/index#dispatchRemote` 不被调用，`/sidebar/remote/api` 对本地会话返回 `not-found → use /sidebar/api`，无 `sshPool` 调用 |
| 路径穿越/符号链接边界 | ✅ 自动化覆盖 | `relativePath` 拒绝 `..`/绝对路径/空段；`isPathInsideWorkspace`/`mutationDenialMode` 覆盖 `upload`/`write`/`edit`/`delete`/`rename`；`remote-fs.ts:remoteListDirectory` 对 `l` 前缀 symlink 并发 `stat` 并置 `broken` 标记，与 better-sidebar 语义对齐 |
| 断线行为 | ⚠️  部分自动化，余下需真机 | `SshConn` 断线 `dead` + 单次重连由 `@dsh-ssh/dsh-ssh` 自带；`RemotePtyManager` 的 `park`/`scheduleClose`/`reconnectGraceMs` 已单测；真机 SSH 重连（见 §6）需真机 |
| 流式传输 | ⚠️  部分 | `remoteReadText` 的 10 MiB 限与 `Sftp`/`ExecFs` 降级、`remoteWriteAtomic` 的分块 base64 已单测；媒体流 `Content-Type` 映射 `mediaTypeForPath` 已单测；大文件分块端到端需真机 |
| HTML 相对资源预览 | ✅ 自动化覆盖 | `encodeHtmlUrl`/`decodeHtmlUrl` 回环已通过；Host 侧 `/sidebar/remote/html/<sid>/<path>` 由 `lib/shared/wire` 提供 |
| SSH PTY cwd | ⚠️  需真机 | `RemotePtyManager.open` 中 `shell` 建立后 `cd` 写入 `cwd` 的最佳努力路径已实现，但真实 `shell` channel 的 cwd 验证需真机 |

---

## 5. 已验证缺陷 / 注意事项

1. **终端 PTY 后端**：`lib/host/remote-pty.js` 通过 `conn.shell({term,cols,rows})` 建立远程 PTY。该方法在 `SshConn` 的公开类型中以 `shell` 形式存在（`ssh2` 的 `Client.shell` 封装），`pnpm typecheck` 通过；但本机无可用远端主机，**未实际建立 shell 通道**，仅静态验证。
2. **HTML 目录穿越**：`decodeHtmlUrl` 对 `/ws/../etc` 的解码本身不拒绝，后续 `resolveRemotePath` + `isPathInsideWorkspace` 二次拒绝的设计与 better-sidebar 的 `isWithin(realpath)` 对齐，属于已知“词法 containment”边界（非安全边界），与威胁模型一致。
3. **`src/host/compat.ts` 为空桩**：当前仅作版本 pin 占位，无运行时 `compat` 断言；不影响验证。

---

## 6. 真机 SSH 专属场景（无法在当前环境自动化，列出复现步骤）

> 需准备一台可 SSH 访问的远端主机（建议 `ubuntu:22.04` + `openssh-server` + `git`），并在本机 `~/.dsh/settings.yaml` 与 `~/.ssh/known_hosts` 中配置 `dsh-ssh-hosts`。

| 场景 | 复现步骤 |
|------|----------|
| 文件树远端 SFTP 枚举 | `dsh -p web` 启动后新建远程会话，侧边栏展开目录，验证排序/隐藏/符号链接展开。断网后重试应显示远端错误而非本地占位目录内容 |
| 读取/编辑/保存 | 在远端打开 `/remote/ws/test.txt`，修改并保存，`ssh <host> 'cat /remote/ws/test.txt'` 核验一致；`old_string` 多次出现时应提示 `use replace_all` |
| 上传/下载 | 拖拽文件到远端目录，`ssh <host> 'ls -l /remote/ws'` 核验；下载远端图片/二进制文件并校验 `Content-Type` |
| 预览相对资源 | 远端创建 `index.html` 引用 `./style.css` 与 `img/x.png`，在侧边栏预览验证相对资源可加载 |
| 终端 PTY | 在远端新建终端，`pwd` 应为远端 `remoteCwd`；`resize`（拖动侧边栏）后 `stty size` 一致；断开 WS 30s 内重连应复用同一 shell |
| Git 远端执行 | 远端 `git init` + commit，侧边栏 `git.status`/`git.diff`/`git.log`/`git.commit` 均应在远端执行；`ssh <host> 'git -C /remote/ws status'` 交叉核验 |
| Host key TOFU | 连接未知主机时应弹出指纹对话框，`fingerprint`/`rawKeyBase64` 正确展示 |
| 大文件/超限 | 上传超过 `uploadLimit`（128 MiB）应获 `too-large`；读取超过 10 MiB 应被截断或拒绝 |

---

## 7. 结论

- t2 的五项验证命令均通过，产物与 tarball 完整。
- 路由/围栏/路径安全/受控内嵌纯函数已有自动化覆盖；本地零回归与远端不回落的不变式已单测固定。
- 终端 PTY 的真实 `shell` 通道、流式大文件、断线重连的端到端语义需真机复现，复现步骤见 §6；不作为 t3 的阻断项，但必须在 t4 审查前由 t4/t5 关注。

---

*Verification executed: `pnpm install --frozen-lockfile` (0) · `pnpm typecheck` (0) · `pnpm test` (21/21) · `pnpm build` (0) · `pnpm pack --dry-run` (23 files) — all evidenced above.*

---

## 8. 补充核查（6 项重点独立复核，对应补充指令）

> 本节为 t3 完成后的独立补充核查（architect 同人复核），**未修改** `src/**`/`test/**`/`lib/**`/`package.json`；所有结论来自本仓库真实命令与代码只读审计。发现的缺陷仅记录，不掩盖。

### 8.1 远程连接/SFTP/exec 故障绝不回落本地占位目录 ✅（已自动化基座，补充代码审计）

- **路由唯一真相**：`routeByCwd(cwd)`（`src/shared/router.ts` 复用 `@dsh-ssh/dsh-ssh/src/router.js`）。`mapRemoteToLocal('h1','/remote/ws')` → `~/.dsh/remote/h1/<enc>` → `routeByCwd → {kind:'remote',hostId:'h1',remoteCwd:'/remote/ws'}`（`test/router.test.js` 回环单测，`node -e` 复核）。
- **故障路径**：`src/host/index.ts:resolveRemoteConn` 仅走 `ctx.get('sshPool').acquire(hostCfg)`；`SshError` 按 `stage` 映射为 `SidebarError('fs-error', stage+message, 403/400)` 直接抛出，无任何 `try→catch→localFallback` 分支。
- **无本地占位读取**：`grep -rn "opendir\|realpath.*placeholder\|better-sidebar.*fs" src/host/` 零命中本地占位目录读取；`grep -rn "readFile\|readdir" src/host/` 命中均为 `conn.sftp().readFile/readdir` 的**远端**类型断言或 `Sftp/ExecFs` 调用（见 `src/host/index.ts:6` 的 `readFile/stat` 为未使用导入，仅 `conn.sftp()` 使用）。
- **本地分支隔离**：`routeByCwd→local` 时 `dispatchRemote` 不被调用，`/sidebar/remote/api` 对本地会话返回 `not-found → use /sidebar/api`（`src/host/index.ts:140`），`sshPool` 零调用。
- **证据**：`node --test test/remote-branch.test.js` 的"route guard holds"用例固定上述不变式；补充 `grep` 输出已留存（见本节审计命令）。

### 8.2 `/sidebar/remote/*` 的 trust fence 与路径穿越 ✅

- **围栏覆盖**：`src/host/index.ts` 的 5 个 `register` + 1 个 `registerUpgrade` 入口均首行 `if (!fence(r)) → 403`：`/sidebar/remote/api`、` /sidebar/remote/address`、`/sidebar/remote/file`、`/sidebar/remote/html`、`/sidebar/remote/upload`、` /sidebar/ws/remote-terminal`。`fence = isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)`（`src/shared/wire.ts`，与 `dsh-better-sidebar/src/trust-fence.ts` 等价）。
- **围栏单测**：`test/wire.test.js` `isTrustedApiRequest({host:'127.0.0.1:3080'})→true`；`sec-fetch-site:cross-site→false`。
- **路径穿越**：`relativePath` 在 `src/host/index.ts:279-281` 拒绝 `''`、以 `/` 或 `\` 起始、含空段/`.`/`..` 的任何段（`split(/[\\/]+/)` 逐段检查）；远端写路径经 `posix.normalize` + `isPathInsideWorkspace(posix.normalize(target), remoteCwd)` 二次拒绝（`workspace-write` 模式，`src/host/index.ts:293,399,410`；`src/host/remote-fs.ts:remoteWriteAtomic` 同理）。补充 `node -e` 核验：`resolveRemotePath('../../etc','/remote/ws', placeholder) → /etc` 被归一后 `isPathInsideWorkspace('/etc','/remote/ws')→false` 拒绝；`decodeHtmlUrl('/sidebar/html/S1/ws/../etc/passwd')` 解码成功但后续 containment 同样拒绝（词法 containment 非安全边界，与威胁模型一致）。

### 8.3 SSH PTY 远端 cwd / resize / close ⚠️（代码已实现但**未真机端到端**，发现阻断缺陷）

- **cwd**：`RemotePtyManager.open(sessionId,tabId,cwd,cols,rows,conn)` 在 `conn.shell({term,cols,rows})` 成功后 `shell.write('cd '+JSON.stringify(cwd)+' 2>/dev/null; clear ...\r')`（`src/host/remote-pty.ts:62-63`），与架构约定的"从真实 `remoteCwd` 启动"一致；`attachRemoteTerminal` 传入 `pooled.remoteCwd`（`src/host/index.ts:490`）。
- **resize**：`ws.on('message')` 的 `type:'resize'` 分支 `handle.shell.setWindow(msg.rows, msg.cols)`（`src/host/index.ts:502`，`src/host/remote-pty.ts:handle.shell.setWindow`），参数顺序为 `(rows, cols)`，与 `RemotePtyManager` 的 `setWindow(rows, cols)` 签名一致；拖动侧边栏触发的 `cols/rows` 经 `new URL(req.url).searchParams` 传入 `open` 时的 `cols/rows`。
- **close/park**：`type:'close' → scheduleClose(key,0)`、`type:'park' → park(key)`、`bare drop → if (!parked) scheduleClose(key,30000)`（`src/host/index.ts:503-511`），`RemotePtyManager` 的 `disposeAll → close` 清理 `WebSocketServer`（`src/host/index.ts:345-349`）。
- **缺陷（阻断，留给 t4 处置，不在 t3 掩盖）**：`SshConn`（`@dsh-ssh/dsh-ssh@0.1.3 src/ssh-core.js`）原型方法为 `constructor, hostId, _resetDeadState, _loadPrivateKey, _readKnownHosts, connect, _connectInner, _close, _ensureOpen, _doExecChannel, _execChannel, exec, execStream, _doSftpOpen, sftp, fs, dispose`，**无 `shell` 方法**（`node -e Object.getOwnPropertyNames(SshConn.prototype)` 实测）。`RemotePtyManager.open` 的 `conn.shell(...)` 在真机调用时将抛 `TypeError: conn.shell is not a function`，`pnpm typecheck` 仅因 `SshLikeConn` 的结构化类型断言通过，未暴露运行时缺失。终端 PTY 的端到端语义因此**未在本环境验证通过**，需 t4 标记为阻断并在 `src/host/remote-pty.ts` 中改用 `exec`+持久化或为 `SshConn` 补充 `shell` 通道。
- **未做真机**：无可用远端主机，未实际建立 `shell` 通道、未 `pwd`/`stty size` 核验，仅静态审计。

### 8.4 Git 全部经远端 exec ✅

- `src/host/remote-git.ts` 全程 `conn.exec('git -C <shellQuoteSingle(cwd)> --no-pager -c color.ui=false <args>')`（`buildGitArgs`），无任何 `spawn`/`child_process`/`opendir` 本地分支；`remoteIsGitRepo`/`remoteRepoRoots` 的容器回退亦经 `conn.exec('ls -1 <cwd>')` + `remoteRunGit` 逐子目录探测（`remote-git.ts:70-88`）。`src/host/index.ts:dispatchRemote#git.*` 仅透传 `remoteCwd/placeholderCwd` 经 `resolveRemotePath` 归一后入 `remoteRunGit`。
- **本地回归**：`grep -rn "spawn\|child_process" src/host/` 零命中（除 `diff` 依赖外）。

### 8.5 package tarball 的 bundle patch 与传递依赖 ✅

- **tarball 内容**（`pnpm pack --dry-run` 23 files）：`cordis.patch.yml`、`lib/client{.js,.d.ts,/index.js}`、`lib/host/{index,compat,remote-fs,remote-git,remote-pty}.*`、`lib/shared/{router,wire}.*`、`lib/index.*`、`package.json`、`README.md`；`package.json#files=["lib/","cordis.patch.yml","README.md"]` 不泄漏 `src`/`test`。
- **bundle patch**（`cordis.patch.yml` 三行 `insert`，含 `disabled: !!js` 去重 guard）：`better-sidebar:dsh-better-sidebar` 防 `web-ui-better-sidebar` 别名重复、`@dsh-ssh/dsh-ssh` 同类 guard、`remote-sidebar:@remote/sidebar-remote`；与 `package.json#dsh.bundle.patch='./cordis.patch.yml'`、`client.platform=web` 一致。
- **传递依赖**：`dependencies: {dsh-better-sidebar:0.17.1, @dsh-ssh/dsh-ssh:0.1.3, diff:^9.0.0, ssh2:^1.17.0, ws:^8.18.0}` 精确锁定上游，`peerDependencies` 声明 `@deepseek-ai/cordis ^4.0.1` 等；`pnpm-lock.yaml` 已提交，`pnpm install --frozen-lockfile` 可复现（见 §1）。
- **证据**：`cat cordis.patch.yml`、`cat package.json | python3 -c "...files/bundle/deps/peer"`、`pnpm pack --dry-run` 输出均在验证会话中执行并留存。

### 8.6 changedPaths scope workaround 不影响实际交付文件 ✅

- t2 的 `changedPaths: ["remote-sidebar-plugin/**"]` 为 AgentTeams 的"glob 作用域为文件类型而非顶层目录"框架限制的**显式 workaround**（`team.json` 可审计），用于绕过 `inScope` 对目录前缀 changedPaths 的校验。
- **实际交付文件**不受该 workaround 影响：`find remote-sidebar-plugin -type f ! -path "*/node_modules/*" ! -path "*/lib/*"` 列出 `src/{client.ts,client/index.ts,host/{compat,index,remote-fs,remote-git,remote-pty}.ts,shared/{router,wire}.ts,types.d.ts,index.ts}` 与 `test/*.test.js`、`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`、`README.md` 等真实产物；`pnpm pack --dry-run` 的 23 files 清单与 `files` 白名单一致证明交付边界正确。workaround 仅影响任务元数据的校验，不产生额外文件或路径漂移。

### 8.7 未做真机 SSH 的限制（重申）

本环境无可用 SSH 远端主机，以下场景**未端到端验证**，复现步骤见前文 §6：SFTP 真实枚举/大文件分块/断网重连、`SshConn` 真实 `connect`/`sftp`/`exec` 链路、PTY `shell` 通道真实 `pwd`/`stty size`、Git 远端仓库真实 `status/diff/log/commit` 交叉核验、Host key TOFU 指纹对话框。本报告的所有通过项均基于单测/静态审计与 `pnpm` 流水线在无真机条件下的可验证子集。

## 9. 真机 SSH 端到端验证与缺陷修复（t4，推翻 §8.7 的"无真机"限制）

本节记录在**真实远程主机**（`example-server` → `198.51.100.24:2222`, user `remote`）上完成的端到端验证，以及据此定位并修复的 7 个缺陷。§8.3 标记的阻断缺陷已解除，§8.7 的"未做真机"限制不再成立。

判定基准（物理上不可伪造）：占位路径 `/home/build/.dsh/remote/<hostId>/L2hvbWUvcmVtb3RlL3dz` 在**本地是空目录**，其对应远程目录 `/home/remote/ws` 含子目录 `diag1`（内有 `data_00000{0,1,2}.bin`、`session.state`）。因此 UI 中出现 `diag1` 即证明数据来自远程。

### 9.1 已修复缺陷清单

| # | 层 | 缺陷 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | client bundle | `routeByCwd` 在浏览器恒返回 `local`（Node 下正常） | `buffer@6.0.3` polyfill **未实现 `base64url` 编码**，`Buffer.from(x,'base64url')` 抛 `Unknown encoding`；`decodeRemotePath` 吞掉异常返回 `null` → `mapLocalToRemote` 返回 `null` → `{kind:'local'}` | `scripts/inject-buffer.mjs` 内置无依赖的 base64url 编解码补丁，标记 `Buffer._isBase64UrlPatched` |
| 2 | client | session 未水合时 fetch/WS 无法路由 | `cwdOfSessionId()` 返回 `null`，无兜底 | 新增 `cwdFromRequest()`：从 URL 查询参数 / JSON body 的 `cwd` 兜底（`URLSearchParams.get()` 与 `JSON.parse()` 已解码，**不可再 `decodeURIComponent`**，否则含 `%`/`+` 的路径会被破坏） |
| 3 | shared/router | 文件树根恒为空 + `No such file` | 上游 `resolveRemotePath` 的 `rel !== ''` 守卫漏掉"恰好等于占位根"的情形：`posix.relative(p,p)===''` → 落到 `posix.normalize()` 把占位路径原样交给 SSH | 在 `src/shared/router.ts` 就地加固同名导出，调用点零改动 |
| 4 | host | 终端 WS 关闭码 1011、`conn.shell is not a function`（即 §8.3 的阻断缺陷） | **双副本 hazard**：两处 `ssh-core.js` 虽同 inode，但 ESM 按解析后 URL 缓存模块；`apply()` 里 patch 的是本插件副本的 `SshConn.prototype`，而 `sshPool` 由 profile 内另一副本创建 | 改为在唯一连接入口 `resolveRemoteConn()` 对 `pool.acquire()` 返回的**活连接实例**调用 `ensureShellOnConn(conn)` |
| 5 | host | 所有目录都被标成文件，`diag1` 无法展开 | `remoteListDirectory` 按 `.filename`/`.longname` 取值，而 `ExecFs.listDir` 实际返回 `{name, type:'dir'\|'file'\|'link'\|'other'}` → 查找必然落空 | 按真实返回形状取值并据 `type` 判定 `isDir` |
| 6 | host | 终端把 JSON 原样渲染进 xterm（只读、满屏垃圾文本） | 协议不匹配：better-sidebar 终端 WS 是**裸文本协议**（`onmessage` 直接 `term.write(event.data)`），仅 resize/close/park 为 JSON；本插件两端都套了 JSON 信封。另 URL 参数是 `tab` 而非 `tabId` | 按上游语义重写 `attachRemoteTerminal`，协议判定抽为纯函数 `classifyTerminalFrame`（`src/shared/wire.ts`）以便单测 |
| 7 | host | 关闭终端标签时 `pty.close` 返回 404 | 该方法缺失，且它只操作本地 manager 状态、不应为此建立 SSH 连接 | 补 `pty.close` 分支并在 `dispatchRemote` 前短路（免连接），同时加固 `RemotePtyManager`（`isParked` + 可移除监听器，避免重连泄漏） |

附带一致性修复：`/sidebar/remote/address` 原先不接受 `cwd` override，会话注册表惰性水合时会 404；已对齐 `/sidebar/remote/file` 与 git 端点的做法。

### 9.2 真机验证证据

**宿主侧（curl / python，真实 SSH）**：

```
POST /sidebar/remote/api/fs.tree   -> 200
{"ok":true,"value":{"path":"/home/remote/ws","entries":[{"name":"diag1","path":"/home/remote/ws/diag1","isDir":true,...}]}}
GET  /sidebar/remote/address       -> 200 {"address":"example-server:/home/remote/ws","kind":"remote",...}
POST /sidebar/remote/api/pty.close -> 200 {"ok":true,"value":{"ok":true}}
WS   /sidebar/ws/remote-terminal   -> 101，裸文本帧（0 个 JSON 信封），pwd -> /home/remote/ws，hostname -> remote
```

**浏览器侧（真实 UI）**：文件树出现 `diag1` 并可展开出 4 个远程文件；折叠→展开→刷新三次活体测试均重新拉取成功；终端提示符 `remote@remotehost:~/ws$`，`pwd`=`/home/remote/ws`、`ls -la` 中 `diag1` 为 `drwxrwxr-x`、`hostname`=`remote`；WS 实际建连 URL 已由 `/sidebar/ws/terminal` 改写为 `/sidebar/ws/remote-terminal`，`readyState=1`、44 帧、无 error、关闭码 1005（**全程无 1011**）；`/sidebar/remote/*` 请求 7/7 全 200；Console 零 `remote-sidebar` 报错、零未处理 Promise 拒绝。

### 9.3 测试基座

`test/browser-bundle.test.js` 在 `vm` 沙箱中加载**真实 `lib/client.js`**，且**刻意不提供 Node `Buffer`**，强制走 polyfill —— 这正是缺陷 #1 对 Node 单测不可见的原因（Node 内置 `Buffer` 支持 `base64url`，会掩盖 polyfill 的缺失）。`test/host-remote-fixes.test.js` 覆盖 #3/#4/#5/#6/#7，其中 #4 用一个"外部模块副本"的 `ForeignSshConn` fixture 复现双副本 hazard。当前 `node --test test/*.test.js` = **66 tests, 66 pass, 0 fail**。

> fixture 陷阱：`ForeignSshConn.connect()` 会覆盖测试预设的 `client`，导致回调永不触发而挂起；需在 `connect()` 后重新注入 stub client。

### 9.4 运维教训：重启 DSH web

- **切勿 `pkill -f 'dsh'`**：该模式会匹配到**调用方自己的 bash 命令行**（其中含 "dsh web" 字样），把刚启动的服务连同 wrapper 一起杀掉，表现为"DSH web 起不来 / 端口不监听"的假故障。应改为按 `:3080` 的**监听 PID** 精确 `kill`。
- **切勿用固定 `sleep` 判断服务就绪**：应轮询端口 / HTTP 状态。按上述两条重写后，重启实测 **2 秒**即 `HTTP 200`（此前多次"卡住 40 秒仍不监听"全部是自杀式 pkill 所致，与插件无关）。
- 插件重装后需重启 DSH web 才会进入 `__DSH_BOOT__`；可用 `curl -s http://127.0.0.1:3080 | grep -o '{"id":"dsh-sidebar-remote"[^}]*}'` 确认（该 id 等于包名，0.2.0 前为 `@remote/sidebar-remote`），并比对 `?rev=` 拉取的 bundle 与磁盘 `lib/client.js` 是否 `diff` 一致，以排除浏览器缓存旧版。
- **改包名就是改插件 id**。它决定 bundle 路径 `/plugins/<id>/client.js`，所以改名必须同步 profile `package.json` 的**两处**（`dependencies` 键 + `dsh.profile.bundles` 项）、`node_modules` 符号链接、`pnpm-lock.yaml` 的 importer 键，然后重启。漏改的症状是旧 URL 404 或插件静默不挂载。手改 lockfile 后可用 `pnpm install --frozen-lockfile` 反向验证：它会因不一致而报 `ERR_PNPM_OUTDATED_LOCKFILE`，通过则证明改对了。

---

## 10. 可移植性根治与发布打包（t5）

### 10.1 本轮定位到的移植阻断点

§9 修完后插件在本机能跑，但**只是巧合**：`scripts/shim-os.mjs` 把 `homedir()` 硬编码为 `/home/build`，而本机 `HOME` 正好是 `/home/build`。叠加 `build-client.mjs` 的 `define: { 'process.env': '{}' }`，浏览器端永远读不到 `DSH_SSH_REMOTE_ROOT` / `DSH_HOME`。静默失败链路：

1. 服务端生成占位路径 `/home/alice/.dsh/remote/<hostId>/<enc>`
2. 浏览器算出 root `/home/build/.dsh/remote`
3. `path.relative()` 得 `../../alice/.dsh/remote/...` → `startsWith('..')`
4. `mapLocalToRemote()` 返回 `null` → `routeByCwd()` 得 `{kind:'local'}`

**全程无任何报错**，症状与缺陷 #1（base64url）完全一致：侧边栏渲染空的本地占位目录。

### 10.2 修法

| 层 | 改动 |
|---|---|
| host | 新增 `GET /sidebar/remote/root`，原样返回 `remoteRoot(process.env)`（过 `fence(r)`） |
| client | 挂载时用**原始 fetch** 探测一次，结果回填给 `routeByCwd(cwd, { DSH_SSH_REMOTE_ROOT: root })`；`DSH_SSH_REMOTE_ROOT` 在 `remoteRoot()` 里优先级最高，因此构建时垫片被完全覆盖 |
| client | `patchedFetch` 对带 `cwd` 的 `/sidebar/*` 请求 `await awaitRemoteRoot()`（上限 1500 ms），消除首屏竞态；放在路由排除项之后，探测请求永不等待自己 |
| shared | 新增 `routeByPlaceholderTail(cwd)`：与 root 无关地识别 `<hostId>/<base64url(绝对路径)>` 形状。`WebSocket` 构造函数是同步的、不能 `await` 探测，开机恢复的终端标签页必须靠它 |
| scripts | `shim-os.mjs` 改为返回构建时 `define` 注入的 `__DSH_BUILD_HOME__`（默认 `os.homedir()`，可用 `DSH_BUILD_HOME` 覆盖），去除硬编码 |

**优先级顺序是刻意的**：权威 root 到手后 `routeByPlaceholderTail` 自动关闭。否则一个形状像占位路径、但实际不在任何 root 下的普通本地目录会被误判为远端，破坏“本地零回归”。`browser-bundle.test.js` 的 `an authoritative root is final` 用例锁死了这个顺序。

### 10.3 真机端到端证据（`npm run verify:live`，11/11）

脚本拉取服务器交给浏览器的**那一份 bundle**（rev `335baf14a110`，85410 bytes），在无 Node `Buffer` 的 `vm` 沙箱里运行，`fetch`/`WebSocket` 直连 `127.0.0.1:3080`，从而驱动真实 SSH。

```
PASS  host serves GET /sidebar/remote/root
      HTTP 200 {"ok":true,"value":{"root":"/home/build/.dsh/remote"}}
PASS  bundled Buffer polyfill carries base64url
PASS  client probed /sidebar/remote/root exactly once, on the original fetch
      hits=1 ["http://127.0.0.1:3080/sidebar/remote/root"]
PASS  client adopted the host-reported root
      [remote-sidebar] placeholder root: /home/build/.dsh/remote
PASS  a local-shaped /sidebar/api call was rewritten to /sidebar/remote/api
      recorded=["http://127.0.0.1:3080/sidebar/remote/api/fs.tree"]
PASS  file tree returned real remote content ("diag1")
      HTTP 200 {"ok":true,"value":{"path":"/home/remote/ws","entries":[{"name":"diag1",...,"isDir":true,...}]}}
PASS  the local terminal WS URL was rewritten to /sidebar/ws/remote-terminal
PASS  remote shell cwd is /home/remote/ws, not the local placeholder
PASS  remote shell lists diag1
PASS  no 1011 / abnormal close on the remote terminal WS
PASS  no warn-level plugin logs (probe succeeded, nothing degraded)
=== 11/11 checks passed ===
```

终端转写（已脱敏，见文首说明；证明跑在远端而非本地占位目录）：

```
Last login: Wed Sep  2 18:11:23 2026 from 198.51.100.81
remote@remotehost:~/ws$ pwd
/home/remote/ws
remote@remotehost:~/ws$ hostname
remote
remote@remotehost:~/ws$ ls -l
total 4
drwxrwxr-x 2 remote remote 4096 Aug 24 17:29 diag1
```

**前后对照（同一台机、同一个 bundle rev）**：重启前宿主跑的是旧代码，`curl -o /dev/null -w '%{http_code}' /sidebar/remote/root` → **404**；重启后 → **200**。client bundle 的 `?rev=` 随磁盘内容变化、按需读取，而 host 代码在启动时载入内存，所以那段窗口里线上实际跑的是“客户端已探测、宿主无端点”的**降级路径**，恰好实证了 404 降级不会阻塞侧边栏。

### 10.4 发布产物审计

| 项 | 结果 |
|---|---|
| `npm pack` | `dist/dsh-sidebar-remote-0.2.0.tgz` · **58 文件** / ≈146 kB 压缩 / ≈498 kB 解包。以文件数为不变量、不钉精确字节数：`docs/` 在包内，改文档就会改包大小（实测一轮 doc 修订使 138.4 → 138.7 kB），追逐精确值是个收不敛的自指回归。两个规避手段：① 近似值对小幅文本增删不敏感，不会每改一次就过期；② 确需修正数字时做**等字节长替换**（如 `139`→`143`，三位换三位），文档大小不变，重打一次即达不动点 |
| `prepack` | 确实执行了 `tsc` + `build-client.mjs`，构建日志打印烙进的兜底 home |
| 清单完整性 | 含 `LICENSE`、`CHANGELOG.md`、`README.md`、`cordis.patch.yml`、`docs/`、`lib/`、`src/`、`scripts/`（含 `verify-live.mjs`）、`test/`、`tsconfig.json`；不含 `node_modules/`、`.npmrc`、`pnpm-lock.yaml`、`.gitignore`、`dist/*.tgz`、`*.map`、`tsconfig.tsbuildinfo` 与开发期探针脚本 |
| 解包自足性 | 解包副本（仅 symlink 上游 peer）直跑 `node --test test/*.test.js` → **79 pass / 0 fail** |
| 产物一致性 | tarball 内 17 个关键文件与工作区**逐字节一致**（`cmp -s` 全部 IDENTICAL）；tarball 内 `lib/client.js`（85406 bytes）与**线上服务返回的 bundle**（rev `634a6f831045`）逐字节一致 —— 故现运行的 profile 虽仍为 `link:`，它下发的就是发布产物本身 |
| 硬编码残留 | 产物中不存在"早退返回硬编码家目录"的形态：`grep -c 'return "<构建机家目录>"' lib/client.js` → **0**；`homedir()` 现为 `return true ? "<构建机家目录>" : "/"`（esbuild 把 `typeof` 守卫折叠成常量，无 define 时仍会保留为运行时守卫）。该字面量等于**构建时**的 `os.homedir()`，随构建机而变，故此处不写死具体路径 |

### 10.5 测试基座变化

`66 tests / 10 suites` → **`79 tests / 11 suites`**，新增 13 项：

- `test/router.test.js` +7：`routeByPlaceholderTail` 的跨 root 识别、与 `routeByCwd` 一致、普通本地路径不误判、非绝对路径编码段拒绝、穿越型 hostId 拒绝、Windows 分隔符、非字符串输入不抛
- `test/browser-bundle.test.js` +5：探测恰好一次且走原始 fetch、跨 `HOME` 占位路径在宿主报告 root 后判为远端、权威 root 压制兜底、探测未回时 WS 仍正确改写（`json()` 永不 resolve 以证明不依赖探测）、宿主 404 时降级不阻塞且必留 warn
- `scripts/verify-live.mjs` 11 项真机断言（不入 `node --test`，需活服务与远端主机）

脚手架适配：`loadBundle()` 把 `/sidebar/remote/root` 分流到独立的 `probeCalls`，使路由断言不必感知探测的存在——否则 4 个既有用例会因 `fetchCalls.length` 从 1 变 2 而假红。

### 10.6 运维教训（本轮新增）

- **`/sidebar/remote/api` 的 method 取自 URL 路径后缀，不是 body 字段**。`curl -d '{"method":"fs.tree"}'` 打到 `/sidebar/remote/api` 会得到 `404 unknown sidebar API method`；正确形状是 `POST /sidebar/remote/api/fs.tree`，body 里放 `{sessionId, cwd, path}`。本轮我又踩了一次（与 §9 的 `pty.close` 404 同类），**均为测试方法错误，非产品缺陷**。
- **API body 必须带 `cwd`**：`sessionCwdOf()` 在有 override 时直接返回、不查注册表；缺了就查惰性注册表，用假 sessionId 必然 404。WS 路径不受此限，因为补丁会把 `cwd` 追加到改写后的 URL 上。
- **pnpm 管理的 profile 里切勿跑 `npm install`**：`~/.dsh/profiles/web` 有 `node_modules/.pnpm` 与 `pnpm-lock.yaml`，npm 会重写为扁平布局并破坏 peer 隔离。统一用 `pnpm add` / `dsh plugin add`。
- **`pnpm` 可能不在 PATH**：本机 `pnpm: command not found`（仅存 `/usr/lib/node_modules/corepack/shims/pnpm`）。故 `prepack`/`prepare`/`verify` 已改为直调 `tsc` 与 `node`，不绑定任何包管理器。
