# 兼容性与公开/非公开接口差距（t1）

> 与 `architecture.md` 共同构成 `t1` 交付物。记录**当前真实发布版本**的约束，`t2` 的版本校验与受控内嵌以此为准。

---

## 1. 当前版本基线（已验证）

| 组件 | 版本 | 获取方式 | 备注 |
|------|------|----------|------|
| DSH | `0.1.1-rc.2` | `$(npm prefix -g)/lib/node_modules/@deepseek-ai/dsh/package.json` | `bin: dsh`，`files: lib/*.js + config`，Cordis `^4.0.1` |
| `dsh-better-sidebar` | `0.17.1` | `npm view dsh-better-sidebar version/dist` · `https://registry.npmmirror.com/dsh-better-sidebar/-/dsh-better-sidebar-0.17.1.tgz`（278 files, 14.7 MB unpacked） | `main: lib/index.js`，`dsh.bundle.patch: cordis.patch.yml` |
| `@dsh-ssh/dsh-ssh` | `0.1.3` | `npm view @dsh-ssh/dsh-ssh version/dist` · `https://registry.npmmirror.com/@dsh-ssh/dsh-ssh/-/dsh-ssh-0.1.3.tgz`（20 files, 374 KB unpacked） | `main: index.js`，`type: module` |
| Node | `>=22`（聚合插件要求） | `@dsh-ssh/dsh-ssh` 的 `engines.node: ">=22"` 为下界 | `dsh-better-sidebar` 声明 `>=20`，聚合后取严格者 |

> **复核命令**（`t2` 前需重跑）：
> ```
> npm view dsh-better-sidebar version
> npm view @dsh-ssh/dsh-ssh version
> cat "$(npm prefix -g)/lib/node_modules/@deepseek-ai/dsh/package.json" | grep '"version"'
> ```

---

## 2. DSH 兼容约束

### 2.1 插件契约

- **Cordis**：`^4.0.1`，`Service` / `ctx.effect` / `ctx.on('domain/changed')` / `ctx.inject(['settings'], ...)` / `ctx.tools.register(defineTool(...))` / `ctx.settings.register(namespace, schema)` / `ctx.webServer.register{path, handler}` / `registerUpgrade` 均按 `0.1.1-rc.2` 的 `dsh-host-webserver` / `dsh-settings` / `dsh-tools` 行为。
- **Bundle 机制**：`package.json#dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh plugin add` 将其 `insert` 行追加到 `dsh.profile.bundles`，profile boot 按序合并 `loader entries`。`disabled: !!js` 表达式在 entry 处理阶段求值，仅可见**此前**的 entries（顺序敏感，见下）。
- **Client 注入**：`dsh.client.inject: ["@deepseek-ai/dsh-client-runtime", ...]` + `platform: web`，`window.__ModuleLoader__.load({id, factory(require)})` 为官方形态；`factory(require)` 仅解析 `web` module map（`react`/`@deepseek-ai/dsh-client-ui-primitives` 等），不解析相对导入。

### 2.2 已知约束与陷阱

- **双挂载去重**：`dsh-better-sidebar` 的 `cordis.patch.yml` 已含 `disabled: !!js "[...ctx.loader.entries()].some(e=>e.options.name==='dsh-better-sidebar' && e.options.id!=='better-sidebar' && !e.disabled)"` 的前向去重；聚合包若同时插入两上游的 `insert` 行，需为**自身**的 `better-sidebar` 行与 `@dsh-ssh/dsh-ssh` 行也加入等价 guard，且聚合包自身的 `remote-sidebar` 行应探测是否已有同名包的旧 mount。顺序要求：聚合包的 patch 中 `dsh-better-sidebar` / `@dsh-ssh/dsh-ssh` 行必须在 `remote-sidebar` 之前，且若用户已通过其他 aggregate（如 `@linxin666/dsh-web-ui-all`）挂载过 `dsh-better-sidebar`（id 可能为 `web-ui-better-sidebar`），`insert` 顺序需保证 guard 可见。
- **`@deepseek-ai/dsh-client-connection` 的 `isTrustedApiRequest` 不导出**：`dsh-better-sidebar/src/trust-fence.ts` 为行为等价的 BSD-3 拷贝，聚合插件同样需自带该 fence，不得 `import` 该内部包。
- **Settings 命名空间白名单**：`dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES` 仅暴露白名单命名空间，`dsh-ssh-hosts` 不在其中；因此 `ctx.remote.$mount(CLIENT_TYPERT_REMOTE)` 的 Typert 通道是 `@dsh-ssh/dsh-ssh` 的官方读写路径，聚合插件不得新增 `api.settings` 直读。

---

## 3. 上游公开 / 非公开接口差距

### 3.1 `dsh-better-sidebar@0.17.1`

| 能力 | 位置 | 公开性 | 对聚合插件的意义 |
|------|------|--------|------------------|
| `name='dsh-better-sidebar'`, `inject=['webServer','sessions','webRuntime','tools','settings'...]`, `apply(ctx,config)` | `lib/index.js` / `lib/types/index.d.ts` | **公开**（`main`/`types`） | 聚合包 `cordis.patch.yml` 的依赖行可直接引用 |
| `Config`（Schemastery schema，`readLimit/mediaLimit/uploadLimit/listLimit/terminalsPerSession/reconnectGraceMs/shell/shellArgs`） | `lib/types/config.d.ts` / `src/config.ts` | **公开** | 聚合包的 Host 配置可复用/扩展 |
| `mediaTypeForPath(path)`、`encodeHtmlUrl`/`decodeHtmlUrl`/`HTML_ROUTE_PREFIX`、`SidebarError`/`writeJson`/`readJsonBody` | `lib/index.js` 内联 / `src/html-route.ts` / `src/wire.ts` | **半公开**（`src/*` 通过 `exports#./src/*` 暴露源码，但 `lib` 未单独导出 `html-route`/`wire`） | 建议**受控内嵌**等价实现并标注来源，避免 `import './src/html-route.ts'` 的源码依赖 |
| `FsEntry` / `GitStatusEntry` / `GitStatusResult` / `GitWorktree` / `GitLogEntry` 等类型 | `lib/types/*.d.ts` | **公开** | Client `api` 契约可直接复用 |
| Client `api`（`sessionCwd/fsTree/fsRead/fsWrite/uploadFile/git*`/`ptyClose` 等） | `src/client/api.ts`（构建为 `lib/client.js`） | **半公开**（`./client` export，但为 bundle 产物） | 远端化时不替换 `api` 形状，仅在 Host 侧分发 |
| `fs-tree.ts`（`listDirectory`/`compareEntries`/`requireAbsolute`/`isWithin`）、`fs-operations.ts`（`writeWorkspaceUpload`）、`path-security.ts`（`ensureWorkspacePath/WritePath`）、`git.ts`（`runGit`/`parsePorcelainZ`/`repoRoots` 等）、`pty-manager.ts`（`PtyManager`） | `src/*` | **非公开**（未导出为 Service/provider，可被 `src/*` 源码引用但无运行时注入点） | **受控内嵌**远端分支的等价逻辑；本地分支仍委托原实现（不 fork 常驻进程） |
| Client 视图 (`FileTree`/`EditorHost`/`TerminalView`/`GitView`/`BrowserView` 等) | `src/client/*` | **非公开**（无 `registerTab`/`registerViewer` 以外的扩展点） | 复用现有视图与 `better-sidebar` 的 tab 注册，仅在数据层按 `routeByCwd` 分发 |

**结论**：`dsh-better-sidebar` 未提供 `fsProvider`/`ptyProvider`/`gitProvider` 的可替换注入点；**无法**以纯扩展方式在不内嵌的情况下完整接管远端语义。选定路径 C 的内嵌范围限于“远端执行分支”，本地分支不内嵌。

### 3.2 `@dsh-ssh/dsh-ssh@0.1.3`

| 能力 | 位置 | 公开性 | 对聚合插件的意义 |
|------|------|--------|------------------|
| `SshPoolService`（`Service('sshPool')`，`acquire/release/invalidate/testConnection`） | `index.js` | **公开**（`Service` 注册，`ctx.get('sshPool')` 可取） | 聚合包 Host 侧**直接消费**，不自建连接池 |
| `router.ts`（`remoteRoot`/`isValidHostId`/`encodeRemotePath`/`decodeRemotePath`/`mapLocalToRemote`/`mapRemoteToLocal`/`routeByCwd`/`resolveRemotePath`） | `src/router.js`（`exports#./src/*`） | **公开** | **直接复用**，为唯一路由真相 |
| `SshConn` / `SshError` / `HOST_KEY_UNKNOWN_STAGE` / `known_hosts` helpers / `shellQuoteSingle` / `buildRemoteCommand` | `src/ssh-core.js` | **公开**（同 `src/*`） | 远端命令/错误模型直接复用 |
| `policy.ts`（`isPathInsideWorkspace`/`mutationDenialMode`/`sandboxDenialError`） | `src/policy.js` | **公开** | 远端沙箱判定直接复用 |
| `HostConfig` / `HostsSettingsSchema` / `readHostsDoc` / `HOSTS_NAMESPACE` | `src/settings.js` | **公开** | 主机配置读写直接复用 |
| `tools.js` / `tools/fs.js` / `tools/bash.js` / `tools/search.js` 的 7 个路由工具（`bash/read/write/edit/read_image/glob/grep`）+ `ROUTED_TOOL_NAMES` / `ROUTED_TOOL_MARKER` / `registerRoutedTools` | `tools.js` | **公开** | 仅作为 **agent 工具**的远端路由；**不**用于侧边栏的文件/终端/Git（侧边栏走 `/sidebar/*` 自有路由） |
| `ExecFs`（`exec+base64` 的 SFTP 回退） | `src/exec-fs.js` | **半公开** | 远端 SFTP 不可用时的回退路径，聚合包可复用 |
| Client 侧 `client.js`（`@dsh-ssh/dsh-ssh` settings 页 + `directoryFlow` 占位创建） | `client.js` | **公开** | 聚合包不替换，仅确保其 `Typert` 远端已挂载 |

**结论**：`@dsh-ssh/dsh-ssh` 的 **router + sshPool + policy** 为聚合包提供了完整的远端执行基座；侧边栏的远端化应构建于其上，而非重复实现 SSH。

---

## 4. 选定实现路径的详细约定

### 4.1 依赖声明

```json
{
  "dependencies": {
    "dsh-better-sidebar": "0.17.1",
    "@dsh-ssh/dsh-ssh": "0.1.3",
    "ssh2": "^1.17.0",
    "diff": "^9.0.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-settings": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-host-webserver": "^0.1.0-rc.6"
  },
  "engines": { "node": ">=22" }
}
```

`pnpm-lock.yaml` 提交，`pnpm install --frozen-lockfile` 可复现。

### 4.2 `cordis.patch.yml` 形态（需经 `t2` 实测去重）

```yaml
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
      disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-better-sidebar' && e.options.id !== 'better-sidebar' && !e.disabled)"
    - id: '@dsh-ssh/dsh-ssh'
      name: '@dsh-ssh/dsh-ssh'
      config: { maxConnections: 4 }
    - id: remote-sidebar
      name: '@scope/remote-sidebar-plugin'
```

- 若用户 profile 已含 `dsh-better-sidebar` 或 `@dsh-ssh/dsh-ssh` 的旧行，上述 `disabled` guard 使旧行优先生效，避免 `duplicate prefix route` 导致整棵插件树启动失败。
- `remote-sidebar` 行无需 guard（聚合包自身唯一），但需在文档中提示“若曾手动挂载旧版聚合包，先 `dsh plugin remove` 再 `add`”。

### 4.3 受控内嵌清单（t2 需在源码头部标注 `Source: dsh-better-sidebar@0.17.1 src/<file>.ts | @dsh-ssh/dsh-ssh@0.1.3 src/<file>.js`）

| 内嵌内容 | 来源 | 用途 | 升级策略 |
|----------|------|------|----------|
| `wire.ts` 的 `SidebarError`/`MAX_BODY_BYTES`/`readJsonBody`/`writeJson`/`writeOk`/`writeError` | `dsh-better-sidebar@0.17.1` | Host `/sidebar/*` 信封 | 上游变更信封时同步 |
| `html-route.ts` 的 `encodeHtmlUrl`/`decodeHtmlUrl` | 同上 | 预览路由 | 同上 |
| `trust-fence.ts` 的 `isTrustedApiRequest`/`isLoopbackHostname` | 同上（BSD-3 拷贝） | 浏览器围栏 | 同上 |
| `fs-tree.ts` 的 `compareEntries`/`requireAbsolute`/`isWithin` 等纯函数 | 同上 | 排序/校验 | 同上 |
| `path-security.ts` 的 `ensureWorkspacePath/WritePath` 的**本地分支**语义 | 同上 | 本地 containment | 同上 |
| `git.ts` 的 `parsePorcelainZ`/`parseWorktreeList`/`parseLogLines` | 同上 | Git 解析 | 同上 |
| `policy.ts` 的 `isPathInsideWorkspace`/`mutationDenialMode`/`sandboxDenialError` | `@dsh-ssh/dsh-ssh@0.1.3` | 远端沙箱 | 上游变更策略时同步 |

> **禁止**内嵌 `SshPool`/`SshConn`/`router` 等已公开模块——直接 `import` 上游包。

---

## 5. 架构契约（对 t2 的强制约束摘录）

1. **唯一路由真相**：`routeByCwd(cwd)`，禁止自建 `cwd` 判断。
2. **显示与身份分离**：`hostLabel:/remote/path` 仅展示，内部携带 `{ hostId, remotePath }`。
3. **远端失败不回落**：`kind===remote` 的任何 `SshError` 不得触发本地 `opendir`/`spawn`。
4. **错误不吞 stage**：`SshError.stage`/`SidebarError.code`/`GitCommandError.code` 原样透出。
5. **连接池复用**：远端 `exec`/`sftp` 均经 `ctx.get('sshPool').acquire(hostCfg)`，不每请求新建 `Client`。
6. **围栏与沙箱**：所有新增 `/sidebar/*` 路由复用 `isTrustedApiRequest`；远端写操作经 `mutationDenialMode` 判定。
7. **生命周期**：所有 `register`/`registerUpgrade`/`on`/`settings.register` 均经 `ctx.effect` 返回 disposer。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 上游发布新版改变 `src/*` 内部实现 | 受控内嵌文件头部固定版本与来源，`t2` 的 `src/compat.ts` 在启动时做版本断言，`docs` 记录升级 checklist |
| 用户 profile 已手动挂载旧版两插件导致双挂载 | `cordis.patch.yml` 的 `disabled: !!js` guard + 文档“先 remove 旧行” |
| 远端 `git` 二进制缺失或版本过低 | `SshConn.exec('git --version')` 预检，`git-error` 透出，前端提示“远端未安装 git” |
| 远端 SFTP 被禁用 | `Sftp` 探测失败时回退 `ExecFs`（`exec` + `base64`），与 `@dsh-ssh/dsh-ssh` 一致 |
| 大文件/大目录导致内存/带宽压力 | `readLimit`/`mediaLimit`/`uploadLimit`/`listLimit`/`remoteMaxFileBytes` 限流，`truncated` 标记 |

---

## 7. 对 t3/t4 的可验证性承诺

- `t3` 的 `docs/verification.md` 需覆盖：`routeByCwd` 单测、`isPathInsideWorkspace` 边界、`SidebarError` 信封、`encodeHtmlUrl` 相对解析、远端失败不回落的故障注入、单包 `pack --dry-run` 清单。
- 真机 SSH 场景（`SshPool` 实连、`git` 远端执行、PTY 交互）若无可用远端主机，需在 `verification.md` 列为“需真机复现”并给出 `ssh -p <port> <user>@<host> 'git status'` 等手动复现步骤，不得伪造自动化通过。
