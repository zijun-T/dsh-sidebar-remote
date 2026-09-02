# 交付说明 — t5 整合交付与安装就绪检查

> 基线：`t1 architecture.md/compatibility.md` + `t2 implement` + `t3 verify` + `t8 r3 repair(F-00/F-01)` + `t9 r3 pass` + 0.2.0 可移植性根治与改名（§6）。本文为最终交付摘要。**未执行 `npm publish`**（需你的 npm 账号）；为验证改名已**重启过** DSH web 并改过 profile 的 `package.json`/`pnpm-lock.yaml`（原文件已备份，详见 §6.4）。

## 1. 交付物

| 产物 | 位置 | 说明 |
|------|------|------|
| 单包插件 | `package.json` → `dsh-sidebar-remote@0.2.0` | 0.2.0 从 `@remote/sidebar-remote` 改名而来（详见 §6）。`peerDependencies` 精确 pin `dsh-better-sidebar@0.17.1` / `@dsh-ssh/dsh-ssh@0.1.3`；`dsh.bundle.patch→./cordis.patch.yml`；`files=["lib/","src/","scripts/","test/","docs/","tsconfig.json","cordis.patch.yml","CHANGELOG.md","README.md"]`；`sideEffects=["./lib/client.js"]`；`author`/`repository`/`homepage`/`bugs` 指向 `github.com/zijun-T/dsh-sidebar-remote` |
| Host/Client 源码 | `src/host/{index,remote-fs,remote-git,remote-pty,ssh-shell-patch,compat}.ts` · `src/client/index.ts` · `src/shared/{router,wire}.ts` | 受控内嵌按 `compatibility.md §4.3` 标注 `Source`；PTY 以 `ssh-shell-patch.ts` 受控补丁扩展 `SshConn.prototype.shell`（复用 `_execChannel` 的 `isNotConnectedError→_dead/_resetDeadState→connect→doShell` 重连与 `SshError{stage:'shell-open'}` 包装） |
| 构建产物 | `lib/**`（`host/*` + `client/*` + `shared/*`） | `pnpm build: tsc -p tsconfig.json` 产出，已验 `ssh-shell-patch.{js,d.ts}` 在 `lib/host/index.js:80` 调用链可审计 |
| 测试 | `test/{router,wire,policy-and-quote,timeout-cleanup,remote-branch,remote-client-routing,browser-bundle,host-remote-fixes}.test.js` | `79 pass / 11 suites`；`browser-bundle` 在**无 Node `Buffer`** 的 vm 沙箱里跑真实 bundle（强制走 polyfill，才能暴露 base64url 缺陷），覆盖跨 `HOME` 占位路径、探测时序、权威 root 压制兜底、WS 同步兜底、404 降级 |
| 真机验收脚本 | `scripts/verify-live.mjs`（`npm run verify:live`） | 拉取服务器交给浏览器的那一份 bundle，vm 沙箱运行并把 `fetch`/`WebSocket` 接到真实服务，驱动真实 SSH；11 项断言全绿。占位 cwd 由**宿主自己报告的 root** 拼出，不硬编码任何机器的 home |
| 文档 | `docs/{architecture,compatibility,verification,review,delivery}.md` · `README.md` | 详见各文档；本文件汇总安装/迁移/验收与已知限制 |
| 锁文件 | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` 可复现 |

## 2. 最终验证（工作区无临时包/秘密/凭据）

| 命令 | 退出码 | 证据 |
|------|--------|------|
| `pnpm install --frozen-lockfile` | 0 | Already up to date / 218ms / pnpm v11.25.0 |
| `tsc -p tsconfig.json` | 0 | 0 errors |
| `node --test test/*.test.js` | 0 | `79 pass / 11 suites / ~110ms` |
| `npm run build` | 0 | `lib/client.js` 85406 bytes（改名前 85410，恰好 −4 = `@remote/sidebar-remote` 22 字符 → `dsh-sidebar-remote` 18 字符，反证改动面只有 id 字符串）；构建日志打印烙进的兜底 home |
| `npm pack --pack-destination dist` | 0 | `dist/dsh-sidebar-remote-0.2.0.tgz` · **58 文件**（稳定不变量）/ ≈146 kB 压缩 / ≈498 kB 解包；`prepack` 自动重建 `lib/`。不钉精确字节数：`docs/` 本身在包内，改文档就会改包大小，追逐精确值是个收不敛的自指回归 |
| 解包审计 | 0 | 解包副本（仅 symlink 上游 peer）直跑 `node --test test/*.test.js` → `79 pass / 0 fail`，证明打包产物自足 |
| 产物一致性 | 0 | tarball 内关键文件与工作区**逐字节一致**；tarball 内 `lib/client.js` 与**线上服务返回的 bundle**（rev `634a6f831045`，85406 bytes）逐字节一致 |
| `npm run verify:live` | 0 | `11/11 checks passed`（改名后重跑，真机 SSH，详见 `verification.md §10`） |

工作区核验：`find remote-sidebar-plugin -type f` 无 `dist/` 外的 `*.tgz` 残留、`~/.ssh`/`settings.yaml` 未被改写、`.npmrc` 仅含 `strict-peer-dependencies`/`auto-install-peers` 两项、源码无明文口令。

## 3. 安装 / 卸载 / 换设备

**安装（单次挂载三行，自动处理传递依赖）：**
```bash
dsh plugin --profile web add /path/to/remote-sidebar-plugin   # 本地路径
dsh plugin --profile web add ./dist/dsh-sidebar-remote-0.2.0.tgz   # 发布产物（推荐换机部署）
# 或发布后
dsh plugin --profile web add dsh-sidebar-remote
```

> profile 若由 **pnpm** 管理（`node_modules/.pnpm` + `pnpm-lock.yaml` 存在），切勿在该目录跑 `npm install`：npm 会重写为扁平布局，破坏 pnpm 的 peer 隔离。统一用 `pnpm add` / `dsh plugin add`。

**卸载（可逆清理：`ctx.effect` 覆盖全部 `register/registerUpgrade/on` disposer，`RemotePtyManager.disposeAll→wss.close+remoteWss.close`）：**
```bash
dsh plugin --profile web remove dsh-sidebar-remote
```

**换设备迁移：** 随 `~/.dsh/settings.yaml` 迁移 `dsh-ssh-hosts`（兼容 `dssh-hosts`）与 `dsh-better-sidebar` 偏好；`~/.ssh/*` 与 `known_hosts` 不自动迁移，需手动复制或用 `@dsh-ssh/dsh-ssh` 的 TOFU 对话重建（见 `compatibility.md §6`）。

**换机部署不需要重新构建。** 客户端在挂载时向 `GET /sidebar/remote/root` 取回权威占位根并回填给 `routeByCwd(cwd, env)`，而 `DSH_SSH_REMOTE_ROOT` 在 `remoteRoot()` 里优先级最高，因此构建时烙进 `lib/client.js` 的 home 只是兜底，一份 bundle 可服务任意部署。只有想让兜底值也正确时才需交叉构建：`DSH_BUILD_HOME=/home/alice npm run build`。

**安装后验收：** `npm run verify:live`（可换 `DSH_ORIGIN`/`DSH_HOST_ID`/`DSH_REMOTE_PATH`/`DSH_EXPECT_ENTRY`），11 项断言覆盖从 bundle 载入到真实 SSH 的完整链路。

**版本约束：** DSH `0.1.1-rc.2`（Cordis `^4.0.1`），`Node >=22`（与 `@dsh-ssh/dsh-ssh engines` 对齐），`dsh-better-sidebar@0.17.1` / `@dsh-ssh/dsh-ssh@0.1.3` 由 `package.json`+`pnpm-lock.yaml` 锁定，`src/host/compat.ts:assertCompat` 于 `apply` 首行校验。

## 4. t9 后的已知限制（非阻断，已在 review 中标注）

- 无可用远端主机：SFTP 真实枚举/大文件分块/断网重连、`SshConn.shell` 真实 `pwd==remoteCwd / stty size / park 30s`、`git status/diff/log` 交叉核验、TOFU 指纹对话框的端到端均**未真机验证**，复现见 `docs/verification.md §6`。代码链完整（`fakeClient.shell(wndopts,{},cb)` 契约冒烟 `before=undefined→after=function, stream.write` 可得、`fetch/WS` 网络拦截证据已补），可按契约判断但仍建议后续真机 `resize/park` 与二级 HTML 相对资源的真机 smoke（建议非阻断的 `t10` 后续）。
- 远端 `compareEntries` 并发度取 `16`（better-sidebar 原 `32`），属可接受实现参数差异（见 `review.md F-06`）。
- `satisfies` 对 `^` 区间的 `rc` 标签未标准化，后续建议以 `semver` 库替换手写比较（`review.md F-04` 建议）。

## 5. 发布前 Checklist

已就绪：

- [x] **包名与 scope**：已按用户决定改为无 scope 的 `dsh-sidebar-remote`。这直接消除了“必须拥有 `@remote` org”的发布阻断项（详见 §6）
- [x] **`author` / `repository` / `homepage` / `bugs`**：已填 `zijun-T` 与 `github.com/zijun-T/dsh-sidebar-remote`。`author` 只用 GitHub 账号、**未编造邮箱**。**曾填错并已更正**：用户名最初从截图误读为 `zjun-T`（漏了 `i`），连 `LICENSE` 版权人共 12 处全错 —— 这类错不会报错，只会在仓库建好后永久 404。发现途径是 `ssh -T git@github.com` 的回显 `Hi zijun-T!`，并用 `git ls-remote https://github.com/<user>/Refractive.git` 交叉确证（`zijun-T` 存在、`zjun-T` 不存在）。教训：**账号名不要靠肉眼读截图**，能用认证回显或 `ls-remote` 确证就用
- [x] **`LICENSE` 版权人**：已从中性表述改为 `Copyright (c) 2026 zijun-T`
- [x] **版本号**：保持 `0.2.0`。不因首发而降到 `0.1.0`：CHANGELOG 的 `0.1.0` 记录了真实的内部基线（含硬编码 home 缺陷），为让首发看起来是 0.1.0 而抹掉那段历史是篡改记录
- [x] `LICENSE` 文件（`package.json` 一直声明 MIT 但文件缺失，属真实合规缺口，npm 也会告警）
- [x] `CHANGELOG.md`（Keep a Changelog 格式，0.2.0 / 0.1.0，含改名条目）
- [x] `sideEffects: ["./lib/client.js"]`（该 bundle 在模块作用域调 `window.__ModuleLoader__.load()`，不得被摇树删除）
- [x] `publishConfig.access` 已**删除**：无 scope 包上它是 no-op，留着反而暗示包仍是 scoped
- [x] `files` 含 `lib/ src/ scripts/ test/ docs/ tsconfig.json cordis.patch.yml CHANGELOG.md README.md`，实测 58 文件；`npm pack` 清单中确认**不含** `node_modules/`、`.npmrc`、`*.tgz`、`*.map`、`tsconfig.tsbuildinfo` 与开发期探针脚本
- [x] `prepack`/`prepare` 改为直调 `tsc` + `node scripts/build-client.mjs`，不再绑定 `pnpm`（本机曾出现 `pnpm: command not found`）
- [x] `.gitignore`（`lib/` 不入库，避免构建产物与 `src/` 漂移 —— 上一轮的 base64url 缺陷就是因为产物与源码不一致而“测试全绿”）
- [x] tarball 解包审计：解包副本直跑 `79 pass / 0 fail`
- [x] 真机端到端：`npm run verify:live` → `11/11`（改名后重跑）

**仍需你完成（我无法代你做，也不会编造）：**

- [ ] **在 GitHub 上创建 `zijun-T/dsh-sidebar-remote` 仓库并推送代码**。`repository`/`homepage`/`bugs` 已按 npm 惯例（仓库名 == 包名）指向该地址，但 `git ls-remote` 实测 **`ERROR: Repository not found.`** —— 仓库尚未创建，所以这三个 URL 目前是**前向引用**，建好前会 404。**git 无法创建远端仓库**（GitHub 不支持 push-to-create），必须先在网页 `github.com/new` 建好，或走 REST API / `gh` CLI。若你想用别的仓库名，改 `package.json` 这三个字段即可，无其他联动
- [ ] **`npm publish`**。需你的 npm 账号登录，我不会代你发布。发布前建议先 `npm publish --dry-run`（清单与 `npm pack` 等价）
- [ ] （可选）**是否把 profile 从 `link:` 换成 tarball 安装**。现运行 profile 仍为 `"dsh-sidebar-remote": "link:<本地插件目录绝对路径>"` —— 改名后我**保留了 `link:`**，因为你目前的工作流依赖它实时生效；已用等价证据代替（tarball 内 `lib/client.js` 与线上服务下发的 bundle 逐字节一致）。确需切换时（把 `<repo>` 换成你的克隆路径）：
  ```bash
  cd ~/.dsh/profiles/web
  pnpm add <repo>/dist/dsh-sidebar-remote-0.2.0.tgz
  ```
- [ ] （可选）**是否把目录 `remote-sidebar-plugin/` 也改名为 `dsh-sidebar-remote/`**。npm 不在乎目录名，且改名会连带修改 profile 的 `link:` 绝对路径与文档里多处引用，故本次**未做**

## 6. 0.2.0 改名记录：`@remote/sidebar-remote` → `dsh-sidebar-remote`

### 6.1 为何不只是改一行元数据

该字符串同时是 **DSH 插件 id**（`src/host/index.ts` 的 `export const name`），因此它决定了：客户端 bundle 路径 `/plugins/<id>/client.js`、启动清单里的 `id`、以及 profile 必须能解析到的模块名。漏改任何一处，症状是 bundle 404 或插件静默不挂载。

### 6.2 传导面（已全部同步）

| 位置 | 改动 |
|---|---|
| `package.json#name` | → `dsh-sidebar-remote`；同时补 `author`/`repository`/`homepage`/`bugs`，删 `publishConfig` |
| `src/host/index.ts` | `export const name` → 新名（传导链源头），并加注释说明它是插件 id 而非标签 |
| `src/index.ts` / `src/client/index.ts` | 文件头注释 |
| `cordis.patch.yml` | `name:` → 新名。**`id: remote-sidebar` 故意不改** —— 那是补丁层自己的别名，与包名无关 |
| `scripts/build-client.mjs` | `pluginId` 改为从 `package.json#name` 读取，不再硬编码 |
| `scripts/verify-live.mjs` | 同上派生 `PLUGIN_ID`，并对正则做转义；失败消息直接提示“profile 里可能还是旧名” |
| `test/browser-bundle.test.js` | 断言拆为两层：钉字面量（抓意外改名）+ 断言 `entry.id === pkg.name`（抓构建派生错误），避开同义反复 |
| `LICENSE` | 版权人 → `zijun-T` |
| `README.md` / `CHANGELOG.md` / `docs/*` | 当前态引用全部更新；**历史审计记录刻意保留旧名**（见 6.5） |
| profile `package.json` | `dependencies` 键改名并归位到字母序；`dsh.profile.bundles` **原位**改名（该数组是加载顺序，聚合插件必须排在两个上游之后） |
| profile `pnpm-lock.yaml` | importer 键改名 + 移到字母序位；`specifier`/`version` 不变（取决于路径而非包名） |
| profile `node_modules/` | 符号链接从 `@remote/sidebar-remote` 移到 `dsh-sidebar-remote`（相对深度 5 → 4），`@remote/` 目录已删 |

### 6.3 验证证据

| 项 | 结果 |
|---|---|
| `tsc` / `node --test` | 0 errors / **79 pass · 11 suites · 0 fail** |
| bundle 字节数 | 85410 → **85406**，恰好 −4 = 22−18 字符差，反证改动面只有 id 字符串 |
| 启动清单 | `{"id":"dsh-sidebar-remote","url":"/plugins/dsh-sidebar-remote/client.js?rev=634a6f831045",...}` |
| 服务页旧名出现次数 | **0** |
| 旧 bundle URL | `GET /plugins/@remote/sidebar-remote/client.js` → **404**（已彻底不再服务） |
| 新 bundle | 200 · 85406 bytes · 与磁盘 `lib/client.js` **IDENTICAL** |
| `pnpm install --frozen-lockfile` | **exit 0** · “Lockfile is up to date, resolution step is skipped” · 0 下载 —— 这反证手改的 lockfile 与 package.json 完全自洽（不一致会以 `ERR_PNPM_OUTDATED_LOCKFILE` 拒绝） |
| `npm run verify:live` | **11/11**，终端转写 `pwd`=`/home/remote/ws`、`hostname`=`remote`、`ls -l` 含 `diag1` |

### 6.4 可回滚

profile 原文件备份在 `/tmp/profile-backup-1788353858/{package.json,pnpm-lock.yaml}.bak`（`/tmp` 会随重启清空，如需长期保留请自行转存）。回滚需同时恢复两个文件、把符号链接改回 `@remote/sidebar-remote`、将插件源码回退到旧名并重启。

### 6.5 历史文档中的旧名是有意保留的

`docs/verification.md` §1–§9 与 `docs/review.md` 里仍出现 `@remote/sidebar-remote@0.1.0`、`remote-sidebar-remote-0.1.0.tgz` 等字样。那些是当时真实跑过的审计快照，改写它们等于伪造记录。**例外**：属于可复用操作指引而非历史记录的处所（如 `verification.md` 里用 `curl` 查启动清单 id 的命令、当前 tarball 文件名）已更新为新名。

---

## 7. 公开前脱敏记录

仓库转为公开前，对全部入库文件（40 个，不含 `lib/`、`dist/`、`node_modules/`）做了一轮敏感信息扫描与替换。

**扫出并移除的**（均非凭据 —— 无私钥、无密码、无 token；拿到也登不进去，但属真实基础设施信息）：内网私有 IP 两个（远程主机地址、登录横幅的来源 IP）、服务器别名与非标准 SSH 端口、`~/.dsh/settings.yaml` 里的真实 host UUID、远端用户名与家目录、构建机家目录、暴露研究工作流的数据文件名与一处项目代号。

**替换原则**：IP 取 RFC 5737 文档专用段（`198.51.100.0/24`）；UUID 取明显合成值（仍满足 `isValidHostId` 的 `^[A-Za-z0-9][A-Za-z0-9._-]*$`）；路径取 `/home/build`（构建机）与 `/home/remote`（远端）。映射表**刻意不记录** —— 记下映射等于没脱敏。

**两处不是简单换字面量**：

| 位置 | 问题 | 处理 |
|------|------|------|
| `verification.md` §10.4「硬编码残留」 | 原文断言产物里 `homedir()` 折叠为某个**具体**家目录字面量。直接替换后，该断言对真实产物**变成假话**（产物烘焙的是构建机实际 `os.homedir()`） | 改为机器无关表述 `<构建机家目录>`，并注明该值随构建机而变 |
| `test/router.test.js` 本地 fixture | 该用例意图是「末段是**合法** base64url 但解码不出绝对路径」。原末段长 8（`len%4=0`）满足；随手换成 `workspace`（长 9，`len%4=1`）会因长度非法而通过 —— 判定相同但**理由变了**，注释随之失真 | 候选末段先经 `decodeRemotePath` 实测，选定 `proj`（`len%4=0`、decode=null、判定 local），同步改注释 |

另有一处**必须成对改**的：远端工作目录的 base64url 编码作为字面量在文档与测试里共 2 处（其中 `browser-bundle.test.js` 用它做 roundtrip 断言），路径改了不同步重算编码就会直接测试失败。已重算并验证。

**验证**：脱敏后 `tsc --noEmit` 0 errors、`node --test` **79 pass / 11 suites / 0 fail**（与脱敏前逐项一致）；12 个敏感模式的残留扫描全部 **0 命中**；以脱敏前的 tarball 为基线逐文件 diff，确认无盲替换造成的语义损伤。
