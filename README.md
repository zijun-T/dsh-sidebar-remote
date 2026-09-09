# dsh-sidebar-remote

单一可安装的 DSH Web 聚合插件——自动集成 `dsh-better-sidebar` + `@dsh-ssh/dsh-ssh`，使 SSH 远程工作区的文件、预览、传输、终端和 Git 真正运行在远端，本地工作区保持原侧边栏行为不变。

无额外 UI、无独立入口。装好即忘：侧边栏自动区分本地与远程会话。

## 安装

```bash
# 本地路径
dsh plugin --profile web add /path/to/remote-sidebar-plugin

# tarball（推荐换机部署）
npm pack
dsh plugin --profile web add ./dsh-sidebar-remote-0.2.0.tgz

# 发布后（npm）
dsh plugin --profile web add dsh-sidebar-remote
```

单次安装即可。`cordis.patch.yml` 会自动挂载聚合插件，上游两个插件通常已随 profile 安装。

移除：`dsh plugin --profile web remove dsh-sidebar-remote`

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

## 已知限制

### sandbox:policy 占位符路径泄露

远程会话的 cwd 使用占位符编码（如 `/home/worker/.dsh/remote/<session-id>/<base64url(remoteCwd)>`），该占位符会直接注入到模型提示词的 `sandbox:policy` context 中，导致模型看到不直观的路径而非真实远端路径（如 `/root/strategy`）。

**原因**：DSH core 在会话创建时注入 sandbox:policy，而插件加载晚于会话创建。DSH 的 agent loop 没有暴露 `systemPrompt.assemble` 或 `agent/pre-step` 事件供插件拦截，因此无法在运行时替换占位符路径。

**影响**：模型提示词中显示占位符路径，可能混淆模型对文件系统的理解。

**解决方案**：需要修改 DSH core 源码，在 sandbox:policy 注入时使用真实远端路径，或请求 DSH 开发者暴露相关的事件/API 供插件拦截。当前暂无插件级解决方案。

**临时规避**：用户可手动配置远端路径或使用其他方式避免依赖提示词中的路径信息。
