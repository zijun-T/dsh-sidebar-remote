# dsh-sidebar-remote

单一可安装的 DSH Web 聚合插件——自动集成 `dsh-better-sidebar` + `@dsh-ssh/dsh-ssh`，使 SSH 远程工作区的文件、预览、传输、终端和 Git 真正运行在远端，本地工作区保持原侧边栏行为不变。

无额外 UI、无独立入口。装好即忘：侧边栏自动区分本地与远程会话。

## 安装

```bash
# 本地路径
dsh plugin --profile web add /path/to/remote-sidebar-plugin

# tarball（推荐换机部署）
npm pack
dsh plugin --profile web add ./dsh-sidebar-remote-0.2.1.tgz

# 发布后（npm）
dsh plugin --profile web add dsh-sidebar-remote
```

单次安装即可。`cordis.patch.yml` 会自动挂载聚合插件，上游两个插件通常已随 profile 安装。

移除：`dsh plugin --profile web remove dsh-sidebar-remote`

## 更新

本包未发布 npm，更新渠道与安装渠道一致。**更新后必须重启 dsh web**（Host 半边无热重载），并硬刷新浏览器（Ctrl+Shift+R）避免沿用旧 client bundle：

```bash
# git URL 安装者：重新解析 git 依赖到最新 main（prepare 脚本自动重建）
cd ~/.dsh/profiles/web && pnpm update dsh-sidebar-remote

# tarball / 本地路径安装者：仓库不含 tgz 产物，需自行打包新版本
git clone https://github.com/zijun-T/dsh-sidebar-remote.git && cd dsh-sidebar-remote
npm install && npm pack                      # 生成 dsh-sidebar-remote-<新版本>.tgz
dsh plugin --profile web add ./dsh-sidebar-remote-<新版本>.tgz

# 核对已生效版本（profile 目录下）
grep '"version"' node_modules/dsh-sidebar-remote/package.json
```

0.2.x 之间插件 id、设置命名空间与 `cordis.patch.yml` 挂载方式均未变化，覆盖安装 + 重启即可，无需任何迁移。

## 远程语义

| 功能 | 远端实现 |
|------|----------|
| 文件树 / 浏览 | SFTP `readdir` + `stat` 探测 |
| 读取 / 编辑 / 保存 | `Sftp.readText` → `applyLiteralEdit` → `writeFileAtomic` |
| 上传 / 下载 | `Sftp.createWriteStream` / `createReadStream`，失败清理 |
| 预览 | `/sidebar/remote/html/<sid>/<path>` + 相对资源同路由 |
| 终端 | `SshConn.shell` PTY，30s 重连优雅期 |
| Git | `git -C <cwd> --no-pager -c color.ui=false` 经 `SshConn.exec` |

本地会话零回归：不建立 SSH 连接，沿用原 `dsh-better-sidebar` 行为。

## 换机部署

不需要重新构建。客户端在挂载时向 `GET /sidebar/remote/root` 取回权威占位根，一份 bundle 可服务任意部署。

迁移 `~/.dsh/settings.yaml` 即可带走主机配置与侧边栏偏好；私钥 / `known_hosts` 不自动迁移，新设备上手动复制 `~/.ssh/*` 或走 TOFU 对话重建。

## 验证

```bash
npm install
npm run typecheck
npm test             # 102 tests / 14 suites，无需网络与远端主机
npm run build
npm pack --dry-run
```

真机端到端：

```bash
DSH_ORIGIN=http://127.0.0.1:3080 \
DSH_HOST_ID=<settings.yaml 里的主机 id> \
DSH_REMOTE_PATH=/path/on/remote \
DSH_EXPECT_ENTRY=<该目录下必然存在的名字> \
  npm run verify:live    # 14 项断言
```

## 依赖

| 组件 | 版本 |
|------|------|
| DSH | `0.1.1-rc.2`（Cordis `^4.0.1`） |
| `dsh-better-sidebar` | `0.17.1` |
| `@dsh-ssh/dsh-ssh` | `0.1.3` |
| Node | `>=22` |

详细架构设计与接口差距分析见 `docs/`。

## 提示词路径改写(sandbox:policy)

远程会话的 cwd 是占位符路径(`<remoteRoot>/<hostId>/<base64url(remoteCwd)>`),DSH core 会把它原样嵌入模型提示词的 `sandbox:policy` context。自 0.2.1 起,插件在组装期把占位符改写回真实远程路径:

- **主路径**:经 `deepseek-harness-zh_pro` 的 `registerAssembleRewriter` 注册「assemble 返回后」改写器(与上下文中文化同流水线,运行于翻译之后);该包缺失时回退为直接包装 `systemPrompt.assemble`。
- **兜底路径**:`agent/pre-step` 监听器(`prepend: true`)对 `decision.messages` 做同样替换。
- 替换映射由 `remoteCwdMapOf()` 构建:host 端 `ctx.sessions.list()` 返回**活会话数组**(不是客户端 `getSnapshot()` 的 `{ byId }` 形状,两者均兼容),占位符 cwd 经 `routeByCwd()` 映射为真实 `remoteCwd`。

验证:远程会话对话的上下文注入中 `sandbox:policy` 显示真实远程路径(如 `/home/ubuntu/MedFluent`),Host 日志输出 `rewriter: replaced "<占位符>" → "<真实路径>"`。
