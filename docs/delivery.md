# 交付说明 — t5 整合交付与安装就绪检查

> 基线：`t1 architecture.md/compatibility.md` + `t2 implement` + `t3 verify` + `t8 r3 repair(F-00/F-01)` + `t9 r3 pass` + 0.2.0 可移植性根治与改名（§6）。本文为最终交付摘要。**未执行 `npm publish`**（需你的 npm 账号）；为验证改名已**重启过** DSH web 并改过 profile 的 `package.json`/`pnpm-lock.yaml`（原文件已备份，详见 §6.4）。

## 1. 交付物

| 产物 | 位置 | 说明 |
|------|------|------|
| 单包插件 | `package.json` → `dsh-sidebar-remote@0.2.0` | 0.2.0 从 `@remote/sidebar-remote` 改名而来（详见 §6）。`peerDependencies` 精确 pin `dsh-better-sidebar@0.17.1` / `@dsh-ssh/dsh-ssh@0.1.3`；`dsh.bundle.patch→./cordis.patch.yml`；`files=["lib/","src/","scripts/","test/","docs/","tsconfig.json","cordis.patch.yml","CHANGELOG.md","README.md"]`；`sideEffects=["./lib/client.js"]`；`author`/`repository`/`homepage`/`bugs` 指向 `github.com/zijun-T/dsh-sidebar-remote` |
| Host/Client 源码 | `src/host/{index,remote-fs,remote-git,remote-pty,ssh-shell-patch,compat}.ts` · `src/client/index.ts` · `src/shared/{router,wire}.ts` | 受控内嵌按 `compatibility.md §4.3` 标注 `Source`；PTY 以 `ssh-shell-patch.ts` 受控补丁扩展 `SshConn.prototype.shell`（复用 `_execChannel` 的 `isNotConnectedError→_dead/_resetDeadState→connect→doShell` 重连与 `SshError{stage:'shell-open'}` 包装） |
| 构建产物 | `lib/**`（`host/*` + `client/*` + `shared/*`） | `pnpm build: tsc -p tsconfig.json` 产出，已验 `ssh-shell-patch.{js,d.ts}` 在 `lib/host/index.js:80` 调用链可审计 |
| 测试 | `test/{router,wire,policy-and-quote,timeout-cleanup,remote-branch,remote-client-routing,browser-bundle,host-remote-fixes,root-label}.test.js` | `102 pass / 14 suites`；`browser-bundle` 在**无 Node `Buffer`** 的 vm 沙箱里跑真实 bundle（强制走 polyfill，才能暴露 base64url 缺陷），覆盖跨 `HOME` 占位路径、探测时序、权威 root 压制兜底、WS 同步兜底、404 降级、**打过补丁的 `WebSocket` 必须保留静态状态常量**（否则上游键盘守卫恒假，见 §8）、以及**真实 bundle 在 stub DOM 上必须把 Files 面板根行改成远端目录名、且不得误改能解码的本地目录**（见 §9）|
| 真机验收脚本 | `scripts/verify-live.mjs`（`npm run verify:live`） | 拉取服务器交给浏览器的那一份 bundle，vm 沙箱运行并把 `fetch`/`WebSocket` 接到真实服务，驱动真实 SSH；14 项断言全绿。占位 cwd 由**宿主自己报告的 root** 拼出，不硬编码任何机器的 home。**调用前提**：`DSH_ORIGIN`/`DSH_HOST_ID`/`DSH_REMOTE_PATH`/`DSH_EXPECT_ENTRY` 必须显式传 —— 入库默认值是脱敏后的合成值，裸跑只能得到 10/14（详见 `verification.md` §10.6 末条）|
| 文档 | `docs/{architecture,compatibility,verification,review,delivery}.md` · `README.md` | 详见各文档；本文件汇总安装/迁移/验收与已知限制 |
| 锁文件 | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` 可复现 |

## 2. 最终验证（工作区无临时包/秘密/凭据）

| 命令 | 退出码 | 证据 |
|------|--------|------|
| `pnpm install --frozen-lockfile` | 0 | Already up to date / 218ms / pnpm v11.25.0 |
| `tsc -p tsconfig.json` | 0 | 0 errors |
| `node --test test/*.test.js` | 0 | `102 pass / 14 suites / ~470ms` |
| `npm run build` | 0 | `lib/client.js` **90384 bytes**（0.2.0 改名审计时为 85406，见 §6.3；其后因终端输入修复而变，见 §8；再因 Files 面板根标签修复而变，见 §9）；构建日志打印烙进的兜底 home。**注**：esbuild 未压缩，依附于**对象字面量属性**的注释会进产物（依附于语句的不会），所以注释文本会影响字节数 —— 已实测确认（同一代码、仅改一处属性注释：85617 ↔ 85814）|
| `npm pack --pack-destination dist` | 0 | `dist/dsh-sidebar-remote-0.2.0.tgz` · **59 文件**（稳定不变量）/ ≈181 kB 压缩 / ≈588 kB 解包；`prepack` 自动重建 `lib/`。不钉精确字节数：`docs/` 本身在包内，改文档就会改包大小，追逐精确值是个收不敛的自指回归 |
| 解包审计 | 0 | 解包副本（symlink **全部 7 个**上游 peer）直跑 `node --test test/*.test.js` → `102 pass / 14 suites / 0 fail`，证明打包产物自足。**注**：peer 必须全挂，只挂一个会以 `ERR_MODULE_NOT_FOUND: @dsh-ssh/dsh-ssh` 假失败 8 个文件 —— 那是审计脚手架的错、非产物缺陷（`verification.md` §11.5 ②）|
| 产物一致性 | 0 | tarball 内**全部 59 个文件**与工作区**逐字节一致**（`cmp -s` 逐个比对，0 差异）；tarball 内 `lib/client.js` 与**线上服务返回的 bundle**（rev `6529611fc875`，90384 bytes）逐字节一致 |
| `DSH_HOST_ID=… DSH_REMOTE_PATH=… DSH_EXPECT_ENTRY=… npm run verify:live` | 0 | `14/14 checks passed`（真机 SSH，详见 `verification.md §10`）。**四个环境变量缺一不可**：脚本的入库默认值是脱敏后的合成值，裸跑会以 `host "11111111-…" not configured` 失败 4 项而得到 10/14 —— 那是调用错误、非产品缺陷（`verification.md` §10.6 末条）|

工作区核验：`find remote-sidebar-plugin -type f` 无 `dist/` 外的 `*.tgz` 残留、`~/.ssh`/`settings.yaml` 未被改写、`.npmrc` 仅含 `strict-peer-dependencies`/`auto-install-peers` 两项、源码无明文口令。

## 3. 安装 / 卸载 / 换设备

**安装（单次挂载，自动处理传递依赖）：**
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

**安装后验收：** `npm run verify:live`（**必须**传 `DSH_ORIGIN`/`DSH_HOST_ID`/`DSH_REMOTE_PATH`/`DSH_EXPECT_ENTRY`，入库默认值是脱敏合成值），14 项断言覆盖从 bundle 载入到真实 SSH 的完整链路。

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
- [x] `files` 含 `lib/ src/ scripts/ test/ docs/ tsconfig.json cordis.patch.yml CHANGELOG.md README.md`，实测 59 文件；`npm pack` 清单中确认**不含** `node_modules/`、`.npmrc`、`*.tgz`、`*.map`、`tsconfig.tsbuildinfo` 与开发期探针脚本
- [x] `prepack`/`prepare` 改为直调 `tsc` + `node scripts/build-client.mjs`，不再绑定 `pnpm`（本机曾出现 `pnpm: command not found`）
- [x] `.gitignore`（`lib/` 不入库，避免构建产物与 `src/` 漂移 —— 上一轮的 base64url 缺陷就是因为产物与源码不一致而“测试全绿”）
- [x] tarball 解包审计：解包副本直跑 `102 pass / 0 fail`
- [x] 真机端到端：`npm run verify:live` → `14/14`（需显式传 `DSH_HOST_ID` 等四个环境变量；裸跑用脱敏默认值只得 10/14，见 `verification.md` §10.6）

**发布与部署事项（我无法代做的部分；第 1 项已完成，留此作记录）：**

- [x] **在 GitHub 上创建 `zijun-T/dsh-sidebar-remote` 仓库并推送代码** —— 已完成。仓库为 public、从空仓起步（未勾 README / .gitignore / license，所以首推无冲突）；首提交 `9fc04ed3` 推上 40 个文件，远端 `refs/heads/main` 与本地 hash 逐字符一致，SSH 与 HTTPS 两种协议均实测可拉到同一 commit。`repository` / `homepage` / `bugs` 三个 URL 因此**不再是前向引用**，已实测可达。遗留知识点：**git 无法创建远端仓库**（GitHub 不支持 push-to-create，这点与 GitLab / Gitea 不同），`git push` 到不存在的仓库只会得到 `ERROR: Repository not found.`；必须先在网页 `github.com/new` 建好，或走 REST API / `gh` CLI
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

**脱敏不是一次性动作 —— 每次提交前都要重扫。** 仓库公开后又修了一个终端输入缺陷（§8），写那部分文档时我把 `verify:live` 的**真机终端转写原样粘了进去**，其中带着已在本节移除的真实远端家目录 —— 等于把脱敏过的 PII 又带了回来。同一份文件的历史 §6.3 用的是脱敏值，新旧并排时我新写的那节是唯一泄漏点。因为提交前对全部入库文件重跑了敏感模式扫描（`git grep -I -n -E`），2 处命中均在未提交的新增段落里，**公开仓库从未出现过**；已用等字节长替换改回脱敏约定，重扫 0 命中。详细过程见 `verification.md` §11.5。

同一次重扫还揪出一处**同类、但已公开**的：§5 第 68 行的用户名更正记录里写了用来交叉确证账号名的另一个仓库名。它也是脱敏**之后**才写入、未经重扫的（随首提交 `9fc04ed` 一起公开）。评估为**零边际暴露**：未认证的 `git ls-remote https://github.com/<账号>/<该仓库>.git` 能直接拿到 HEAD，说明它是**公开仓库**，本就列在该账号的公开主页上，且账号名已充满 `package.json` / `LICENSE` / `repository` 字段。故**保留不改、也不重写历史**（重写需对 `main` 强推，代价远于一处已公开且无增量信息的仓库名）。教训同上：判定敏感与否要看**边际暴露**，而不是只看字面是否“看起来像真实信息”。

---

## 8. 终端完全无法输入（仓库公开后修复）

**症状**：远程终端能连上、输出实时滚动、提示符里的 cwd 是正确的远端路径，但键盘打什么都没反应。

### 8.1 排除过程

先分清“坏在服务端还是浏览器层”，再谈修复：

| 步骤 | 手段 | 结果 |
|------|------|------|
| 服务端输入路径 | `npm run verify:live`（它第 158 行确实在测输入：`ws.send('pwd\r')` 后断言回显） | **11/11**，转写里有 `pwd`→`/home/remote/ws`、`hostname`、`ls -l` —— 服务端、线路协议、路由全部正常 |
| 上游契约比对 | 读 `dsh-better-sidebar/lib/index.js` 的 `attachTerminal` | 我们的 `attachRemoteTerminal` 与上游**逐项一致**（`onExit` 只发文字不关 WS、`if (handle.exited) return`），所以“shell 退出后冻结”是上游既有契约，不能拿它当缺陷改 |
| 浏览器层 | 把**服务器实际下发的那一份 bundle** 放进 vm 沙箱，挂载 overlay 后在沙箱内**逐字执行上游 `client-terminal.js:9217` 的守卫表达式** | 见 8.2 |

### 8.2 根因

上游键盘输入的唯一出口是：

```js
const inputSub = term.onData((data) => {
  if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(data)
})
```

它用**全局构造函数的静态常量** `WebSocket.OPEN` 做守卫。而客户端 overlay 把 `globalThis.WebSocket` 换成了一个普通函数，只拷了 `prototype`、**没拷静态 `CONNECTING`/`OPEN`/`CLOSING`/`CLOSED`**。函数对象的 `[[Prototype]]` 是 `Function.prototype`，里面没有这些常量，于是 `WebSocket.OPEN === undefined`，`readyState === undefined` **恒为 false**，`socket.send()` 永远不可达。

实测证据（修复前，拉的是线上 bundle rev `93a7fca5b2ef`）：

| 观察点 | 值 |
|---|---|
| overlay 挂载前 `WebSocket.OPEN` | `1` |
| 挂载后 `CONNECTING`/`OPEN`/`CLOSING`/`CLOSED` | **全部 `undefined`** |
| WS 是否连上远端终端 | 连上了，URL 正确重写到 `/sidebar/ws/remote-terminal` |
| `socket.readyState` | `1`（OPEN） |
| 上游守卫 `readyState === WebSocket.OPEN` | **false** |
| 实际发出的按键数 | **0** |

两个原因让它隐蔽：**接收方向不查这个常量**，所以输出、提示符、地址全正常；而路由测试只断言重写后的 **URL**，那部分一直是好的。

连带影响：`resize` / `close` / `park` 控制帧同样发不出去（同一个守卫），所以宿主侧 pty handle **从未被释放**，一直在泄漏。

注：这个守卫是全局的，所以**本地终端同样打不进字**，不限于远程。

### 8.3 修复

把包装函数换成 `Proxy`。Proxy 会**转发全部静态属性与 `prototype`**，所以不存在“又漏拷了某个静态”这类缺陷；`construct` 陷阱里做 URL 重写，另加 `apply` 陷阱（浏览器的 `WebSocket` 不可 `[[Call]]`，该陷阱正常不可达；保留它是为了当我们捕获到的全局已经是别人的普通函数补丁时，不会退化成“可调用但转发未重写参数”、静默绕过自己的路由）。

同时修了一个**同症状的次要隐患**：`attachRemoteTerminal` 里 `try { handle.shell.write(...) } catch {}` 把写入异常静默吞掉。SSH channel 半死（VPN 断开、服务端 idle 踢人）而未发 `close` 时，`handle.exited` 仍为 false、socket 仍开着、按键全部消失，而客户端把“socket 开着”读作健康所以永不重连 —— 表现与 8.2 一模一样。现在会把原因写回面板并以 `1011` 关闭 socket。

### 8.4 为何 79 条测试全绿却漏掉

`test/browser-bundle.test.js` 的 stub 只设了 `sandbox.WebSocket.OPEN = 1`（四个常量只设了一个），且 `apply()` 之后**从未回头检查打过补丁的那个构造函数**；stub 的 `send` 还是空函数，丢弃了所有调用。三重叠加：常量丢看不出来、发送也不被记录。

已修：stub 改为 `class`（浏览器的 `WebSocket` 本就不可 `[[Call]]`，普通函数 stub 保真度不够）、四个常量齐备、`send()` 记录到 `wsSends`；新增一条测试直接断言四个静态与“一个按键确实到达 socket”。

**新测试已验证有牙**：把 `src/client/index.ts` 退回修复前版本重建（旧 bundle 85406 bytes、`grep -c 'new Proxy'` = 0），该测试报 `not ok 1 - patched WebSocket lost the static CONNECTING`；还原后 bundle 与备份 IDENTICAL。不会失败的回归测试等于没测试。

### 8.5 验证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 errors |
| `node --test` | **80 pass / 11 suites / 0 fail** |
| 静态常量（线上 bundle） | `CONNECTING=0` `OPEN=1` `CLOSING=2` `CLOSED=3` 全部转发 |
| 上游守卫表达式 | **true**，按键发出 **1** 个 |
| URL 重写 | 仍正确改写到 `/sidebar/ws/remote-terminal` 并携 `cwd` |
| `npm run verify:live` | **11/11**（显式传四个环境变量；frames=21，转写含 `pwd`/`hostname`/`ls -l` 真实回显）|
| 产物一致性 | 线上 rev `a2e8d79c4349`、85814 bytes，与磁盘 `lib/client.js` **IDENTICAL** |

服务从磁盘读 `lib/client.js` 并现算 `rev`，所以**不需重启 DSH**，浏览器刷新即可拿到修复。

---

## 9. Files 面板根行显示 base64url 尾巴（仓库公开后修复）

现象：远端工作区的文件树**内容全对**，但顶部根行读作 `L2hvbWUvcmVtb3RlL3dz`，而同一个会话的左侧工作区行、中间面包屑、终端提示符都显示真实目录名。判定方法与实测数据见 `verification.md` §12。

### 9.1 逐元素定位

| 界面元素 | 显示 | 来源 | 是否正确 |
|---|---|---|---|
| 左侧工作区行 | `<主机名> / ws` | DSH core 调 dsh-ssh 的 `placeholderWorkspaceTitle()` | ✓ |
| 中间面包屑 | `<主机名> / ws` | 同上 | ✓ |
| 终端提示符 | `remote@remotehost:~/ws$` | 远端 shell 自己 | ✓ |
| **Files 面板根行** | **`L2hvbWUvcmVtb3RlL3dz`** | better-sidebar `FileTree`：`const root = cwd`（`client-registry.js:11993`）→ `baseName$1(root)`（`:12114`） | **✗** |
| Files 面板里的子行 | 真实远端文件名 | 我们的 `fs.tree`（返回解码后的真实路径） | ✓ |

三处对、一处错，正是它长期没被注意到的原因 —— 内容对得让人以为标签也对。

### 9.2 为何线路层修不了

根标签是**客户端本地**对 `scope.cwd`（`cwd: folderRoot ?? scope.cwd`）取 basename 得出的，而远端会话的 `cwd` 就是占位路径 `<root>/<hostId>/<base64url>`，basename 自然是那段编码。三条排除证据：

| 可能的干净修法 | 实测结论 |
|---|---|
| 让客户端消费宿主 `session.cwd` 返回的 `root` 标签 | 上游**没有任何一处**读那个字段（0.17.1 里它是死代码） |
| 升 pin 到 `0.18.0-alpha.0` | 逻辑逐字相同（`const root = cwd` → `baseName$1(root)`），全文无占位解码引用 —— 上游没修 |
| 把 `cwd` 改成真实远端路径 | 不可行：占位路径正是**所有路由判定的键**，改了会同时打断 `fs.*`/`git.*`/PTY 三路 |

讽刺的是 `@dsh-ssh/dsh-ssh` **早就知道这个陷阱**：`placeholder.js` 的注释原文写着「The placeholder directory name is a base64-encoded segment (e.g. L2hvbWUv...), so we derive the title from the real remote path instead」，并提供了 `placeholderDisplayName()` —— 只是 `FileTree` 从来没调它。而该助手**不能直接 import**：`placeholder.js:13` 顶层 `import fs from 'node:fs'`，esbuild 会把它变成浏览器里无法满足的 `require()`。

### 9.3 修法

在 `shared/router.ts` 里逐字**镜像**那 4 行为 `remoteDisplayName()`（不 import），客户端用 `MutationObserver` 修正**已渲染的文本**：React 拥有那段文本，一次性改写不够 —— 会话切换、树重载、恢复 tab 都会把编码尾巴放回来。真实远端路径写进根行的 `title`，与子行暴露自己路径的方式一致（否则信息反而变少）。

两个刻意约束：

1. **标签由 `routeOf()` 推导，而不是由“这段文本能不能解码”推导。** 本地目录名恰好是规范 base64url 的（`L2E` → `/a`）绝不能被改，否则会破坏“本地零回归”不变量。走 `routeOf()` 意味着本修复**完全继承路由的判定**（包括 `routeByPlaceholderTail` 已记录并接受的巧合面），而不是另加一个可能与之矛盾的第二意见。
2. **变更合并到定时器上（120 ms），不逐条 record 处理。** xterm 面板是持续的 mutation 流，逐条全量重扫是可测量的开销；而文件夹名 120 ms 的陈旧不可见。另加两次有界重试（250/1000 ms）应付启动竞态：sessions 快照可能在树首次绘制时仍为空，而之后可能没有 mutation 来唤醒 observer。

选择器不能只靠 class：`explorerName` 在三处共用（`12036`/`12075`/`12113`，只有 `12113` 是根行），所以靠“每个 explorer body 的**第一个** explorerRow”定位（`querySelector` 返回文档序首个匹配，而上游先渲染根行再 `renderLevel(root, 0)`），且改写后文本不再匹配任何编码尾巴 → 幂等。

### 9.4 测试基座变化

`80 tests / 11 suites` → **`102 tests / 14 suites`**，新增 22 项。诚实说：**这不是“测试漏网”** —— 在 80 项里根本没有任何一项触及渲染后的 DOM 文本，覆盖面到线路与路由为止。本修复新增的是**第一层 DOM 级覆盖**：

- `test/root-label.test.js`（17 项 / 3 suites）直接驱动 `remoteDisplayName()` / `rootLabelFixes()` / `fixExplorerRootLabels()`：本地目录假阳性、形状兜底的已记录巧合、两个会话两个面板、远端文件系统根（`/` → `root`）、子行本身名字就像编码尾巴、幂等、DOM 抛异常
- `test/browser-bundle.test.js` +5：用 stub `document` 与 `MutationObserver` 驱动**已发布的 bundle**（挂载即改、重渲染后再改、`dispose()` 后停手、能解码的本地目录不动、完全无 DOM 时干净挂载），并断言 bundle 里**不带 `node:fs`**

已验证**有牙**：把两个源文件退回 HEAD 重建（产物恰为 85814 bytes = HEAD 那一份），上述 5 项里 3 项报红，`root-label.test.js` 则因导入不到助手而整个文件失败；还原后产物与备份逐字节一致。其中“本地目录不动”那项**两边都绿是设计如此** —— 它防的是过度修改（负向测试），不是本缺陷。

`scripts/verify-live.mjs` 同步 +3 项断言（现 **14 checks**），跑在服务器实际下发的那一份 bundle + 宿主自己报告的 root 拼出的占位 cwd 上，所以标签是端到端验的、不只在 stub 里。其中一项先把标签改回编码尾巴、手动触发 observer 回调、再断言它被改回来 —— 那才是“修复”与“一次性重绘”的区别。

### 9.5 验证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 errors |
| `node --test` | **102 pass / 14 suites / 0 fail** |
| `npm run verify:live`（显式传四个环境变量） | **14/14**，frames=18；根行标签 = `DSH_REMOTE_PATH` 的 basename，`title` = 真实远端路径 |
| 裸跑（脱敏合成默认值） | **10/14**；3 项新断言不依赖 SSH（只需 DOM stub + 宿主报告的 root），仍绿；失败的 4 项均为依赖 SSH 的旧断言 |
| 产物一致性 | 线上 rev `6529611fc875`、90384 bytes，与磁盘 `lib/client.js` **IDENTICAL** |
| 本地零回归 | 能解码的本地目录名不被改写（单测 + bundle 级各一项）；无 DOM 时静默跳过，路由不受影响 |
| 真浏览器截图 | **无**。浏览器子代理仍被同一基础设施错误（`Notification handler already registered`）阻塞，已尝试且如实报告失败。DOM 行为已由 stub 驱动的真实 bundle + 真机 14/14 覆盖 |

### 9.6 附带抓到的一处脱敏回退：base64url **不是**脱敏

写本节的源码注释时，我把用户截图里那串标签原样粘进了 `src/client/index.ts`。它是 base64url，解码后正是 §7 已移除的两类信息（真实远端家目录 + 暴露研究工作流的项目目录名）。危险在于：**普通敏感模式 grep 完全扫不到它** —— 字面上既不含用户名也不含路径。`src/` 既入库又在 npm `files` 白名单里，仓库和包会同时发布它。

提交前改用了**解码级扫描**：把入库文件里所有 `[A-Za-z0-9_-]{16,}` 形状的 token 全部 base64url 解码，再对解码结果跑敏感模式。结果：高危命中 **2 处**（同一行的编码 token 与紧随的明文），已按 §7 约定改回合成值，重扫 **0 命中**。附带一个反证：修正前后重建的 `lib/client.js` **sha256 完全相同** —— 该 token 位于语句级注释，esbuild 丢弃它（见 §8.4 注），所以它**从未进入已发布的产物**，只在源码里。

教训两条：① 任何编码/哈希/转写形式都不构成脱敏，扫描必须能**逆向**到明文；② 从用户提供的截图、日志、转写里拷任何东西进仓库前，先当作未脱敏输入处理。
