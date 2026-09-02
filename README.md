# dsh-sidebar-remote

单一可安装、可迁移的 DSH Web 聚合插件，自动挂载 `dsh-better-sidebar@0.17.1` + `@dsh-ssh/dsh-ssh@0.1.3`，使 SSH 远程工作区的文件、预览、传输、终端和 Git 真正运行在远端，本地工作区保持原侧边栏行为不变。

> **包名与插件 id**。本包在 0.2.0 从 `@remote/sidebar-remote` 改名为无 scope 的 `dsh-sidebar-remote`（两个名字都从未发布过）。该字符串同时是 DSH 插件 id，所以它决定了客户端 bundle 路径 `/plugins/<id>/client.js` 与启动清单里的 `id`。升级时**必须同步**改 profile `package.json` 的两处（`dependencies` 键与 `dsh.profile.bundles` 项）并重启 DSH web，否则旧 id 的 bundle 路径会 404。`cordis.patch.yml` 里的 `id: remote-sidebar` 是补丁层自己的别名，与包名无关，不跟着改。

## 安装

```bash
# 本地路径安装（开发/离线）
dsh plugin --profile web add /path/to/remote-sidebar-plugin

# 从 tarball 安装（发布产物，推荐用于换机部署）
npm pack                                              # 得到 dsh-sidebar-remote-<ver>.tgz
dsh plugin --profile web add ./dsh-sidebar-remote-0.2.0.tgz

# 发布后（npm）
dsh plugin --profile web add dsh-sidebar-remote
```

单次安装即可：`cordis.patch.yml` 的三行 `insert` 会按序挂载 `better-sidebar` → `@dsh-ssh/dsh-ssh` → `remote-sidebar`，并通过 `disabled: !!js` 去重 guard 避免与已手动安装的上游重复导致 `duplicate prefix route`。

从源码安装时 `prepare`/`prepack` 会自动构建 `lib/`；`lib/` 已 `.gitignore`，克隆后请显式执行 `npm run build`。

移除：

```
dsh plugin --profile web remove dsh-sidebar-remote
# 若曾手动挂载过两上游，保留它们或一并 remove
```

## 架构

- 路由唯一真相：`@dsh-ssh/dsh-ssh/src/router.js` 的 `routeByCwd(cwd, env?)`。
- 占位根发现：浏览器算不出 `remoteRoot()`（`process.env` 被 esbuild 编译成 `{}`，`os.homedir()` 是构建时垫片），所以宿主提供 `GET /sidebar/remote/root` 返回权威值，客户端在挂载时探测一次并回填到 `routeByCwd` 的 `env` 参数。**一份 bundle 因此可服务任意部署**。
- 同步兜底：`WebSocket` 构造函数不能 `await` 探测，故 `routeByPlaceholderTail()` 以与 root 无关的方式识别 `<hostId>/<base64url(绝对路径)>` 形状；权威 root 到手后该兜底自动关闭，本地零回归保证仍然精确。
- 显示与身份分离：地址栏显示 `hostLabel:/remote/path`，内部流转 `{ hostId, remotePath }`，禁止把显示文本反解析为身份。
- 远端失败不回落本地占位目录：`kind===remote` 的任何 `SshError` 直接以 `SidebarError` 透出。
- 远端数据路径：`sshPool.acquire(hostCfg)` → `Sftp` / `ExecFs` / `exec git -C <cwd>` / `shell PTY`。
- 本地零回归：`kind===local` 时零 SSH 连接，沿用原 `dsh-better-sidebar` 行为。
- 远程路由：`/sidebar/remote/*`（与本地 `/sidebar/*` 并存，不碰撞）。客户端按会话路由选择目标。
- 终端双通道：本地走 `node-pty`（better-sidebar 原有），远端走 `SshConn.shell` PTY，经 `/sidebar/ws/remote-terminal`。
- 安全：复用 `isTrustedApiRequest` 围栏；远端写操作经 `mutationDenialMode` + `isPathInsideWorkspace` 判定；命令经 `shellQuoteSingle` 转义。

## 远程语义

| 功能 | 远端实现 |
|------|----------|
| 文件树/浏览 | `Sftp.readdir` / `ExecFs.listDir` + 受控内嵌 `compareEntries` |
| 读取/分窗 | `readText` + `readLimit` 窗口，上限 10 MiB |
| 编辑/保存 | `readText` → `applyLiteralEdit` → `writeFileAtomic` (tmp+rename) |
| 上传/下载 | `createWriteStream` / `readFile` + `mediaLimit`/`uploadLimit`，失败清理 |
| 预览 | `/sidebar/remote/html/<sid>/<path>` + `encodeHtmlUrl` 相对资源同路由 |
| 终端 | `SshConn.shell({term,cols,rows})` 30s 重连优雅期，transcript 1 MiB |
| Git | `git -C <remoteCwd> --no-pager -c color.ui=false <subcommand>` |

## 配置与凭据迁移

- 主机：`~/.dsh/settings.yaml` 的 `dsh-ssh-hosts`（兼容 `dssh-hosts`）随 `~/.dsh` 迁移。
- 侧边栏偏好：同 `settings.yaml` 的 `dsh-better-sidebar` 命名空间。
- 私钥/`known_hosts` 不自动迁移：新设备上手动复制 `~/.ssh/*` 或重建，首次连接走 TOFU 对话。
- 插件包：`pnpm-lock.yaml` 已提交，`node >=22`。

### 换机构建

`lib/client.js` 里烙进的 home 目录只是**兜底**，运行时以 `GET /sidebar/remote/root` 的权威值为准，所以换机部署**不需要重新构建**，也不需要改任何源码。

只有在明确知道目标机 home、且想让兜底值也正确时才需要交叉构建：

```bash
DSH_BUILD_HOME=/home/alice npm run build
```

构建日志会打印实际烙进的值。若宿主未提供该端点（旧版本），客户端会记一条 warn 并降级到与 root 无关的形状判定，侧边栏不会被阻塞。

## 验证

```
npm install          # 或 pnpm install --frozen-lockfile
npm run typecheck
npm test             # 79 tests / 11 suites，无需网络与远端主机
npm run build
npm pack --dry-run
```

`npm test` 只依赖 `node:test` 与已打包的 `lib/`，因此对**解包后的 tarball** 同样可跑，无需 devDependencies。

### 真机端到端验证

单测只能分别证明两半；`verify:live` 跑完整链路：拉取服务器交给浏览器的**那一份 bundle**，在无 Node `Buffer` 的 vm 沙箱里运行（强制走打包进来的 polyfill），并把它的 `fetch`/`WebSocket` 接到真实服务，从而驱动真实 SSH。

```bash
npm run verify:live
# 换到别的部署时只需换环境变量，不需改脚本：
DSH_ORIGIN=http://127.0.0.1:3080 \
DSH_HOST_ID=<settings.yaml 里的主机 id> \
DSH_REMOTE_PATH=/path/on/remote \
DSH_EXPECT_ENTRY=<该目录下必然存在的名字> \
  npm run verify:live
```

它覆盖 11 项断言：bundle 可载入、base64url polyfill 生效、`/sidebar/remote/root` 存在且客户端探测一次并采纳其值、`/sidebar/api/*` 被改写为 `/sidebar/remote/api/*`、文件树返回真实远端内容、终端 WS 改写到 `/sidebar/ws/remote-terminal`、`pwd` 为远端真实路径、无 1011 异常关闭、无 warn 降级。

判定基准不可伪造：本地占位目录是空的，`DSH_EXPECT_ENTRY` 只可能来自远端。

脚本不硬编码任何机器的 home：占位 cwd 由**宿主自己报告的 root** 拼出，所以拿到另一台机器上直接能跑。

更多历史证据：`docs/verification.md`。

## 版本锁定

- `dsh-better-sidebar@0.17.1`、`@dsh-ssh/dsh-ssh@0.1.3`、`ssh2 ^1.17.0`、`diff ^9.0.0`。
- DSH `0.1.1-rc.2`（Cordis `^4.0.1`）。见 `docs/compatibility.md`。
