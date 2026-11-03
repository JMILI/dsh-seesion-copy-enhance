# dsh-seesion-copy-enhance（会话复制增强）

把会话里的一条消息**整条**复制出来——文字、图片、视频、文件——再粘贴回**任意**会话，附件依然在。

DSH 自带的复制按钮只写 `text`，所以带截图或附件的消息复制到别处就只剩文字。这个插件接管复制按钮，
把完整消息放进剪贴板；粘贴时再把附件还原成真正的草稿附件，直接就能发送。

- 插件包名：`dsh-seesion-copy-enhance`（拼写沿用最初约定的 `seesion`，安装时请照抄）
- 版本：`0.2.0`
- 许可证：MIT，开源仓库见 [GitHub](https://github.com/JMILI/dsh-seesion-copy-enhance)

## 功能

| 操作 | 原版 | 装插件后 |
| --- | --- | --- |
| 复制带图片的消息 | 只有文字 | 文字 + 全部图片 |
| 复制带文件/视频的消息 | 只有文字 | 文字 + 全部附件 |
| 粘贴到另一个会话 | 纯文本 | 文字 + 附件卡片，可直接发送 |
| 粘贴到同一会话 | 纯文本 | 文字 + 附件卡片 |
| 粘贴到富文本应用（Word、Notion、邮件） | 纯文本 | 文字 + 内嵌图片 |
| 刷新页面后再粘贴 | 纯文本 | 文字 + 附件（通过 Host 桥恢复） |

剪贴板里同时有两种格式：`text/plain`（干净的文字，粘到终端也没问题）和 `text/html`
（带隐藏的媒体 token 与内嵌 `data:` 图片）。粘贴时客户端识别 token，向 Host 取回整包数据，
把每一项还原成真正的 `File`，交给会话服务的草稿附件通道——和拖拽上传走同一条路。
附件是真的草稿，会正常上传、正常发送，没有任何"假附件"。

## 支持的版本

| DSH 版本 | 状态 | 说明 |
| --- | --- | --- |
| `0.2.1-rc.5` | ✅ 已实测 | 本机全链路验证：capture / resolve / 剪贴板写入 / 附件还原 |
| `>=0.2.0 <0.3.0` | ✅ 声明支持 | `package.json` 的 `engines.dsh`，市场与安装器按此校验 |
| `0.2.x` 其他 rc | ⚠️ 预期可用 | 用的是 0.2 公开插槽与服务，未逐个 rc 验证 |
| `0.1.x` | ❌ 不支持 | 缺少 `conversation.composer.dock` 插槽与 `createDrafts` 草稿通道 |
| `>=0.3.0` | ❌ 未声明 | 新主版本需重新验证后再放宽 |

运行时也会自检：`GET /dsh-seesion-copy-enhance/health` 返回 `version` 与 `capabilities`
（`readImage` / `readFileStream` / `imageHostPath` / `fileHostPath` 是否存在）。
若宿主缺少某项能力，插件**不会报错**，而是退化为"只复制文字"并在提示里说明，
原有的复制粘贴行为完全不受影响。

## 安装

### 1. 插件市场（推荐）

在 DSH 里打开 **Plugins → Discover**，搜索 `dsh-seesion-copy-enhance`（或"会话复制增强"），
点安装 → 按提示重启 / 刷新。

### 2. 命令行

```powershell
dsh plugin --profile desktop add dsh-seesion-copy-enhance
```

`--profile` 换成你实际使用的 profile（桌面版默认 `desktop`，Web 版常见 `web`）。

### 3. 应用内插件管理器（本地包）

先打包，再安装 `.tgz`：

```powershell
pnpm pack --pack-destination C:\Users\<你>\.dsh\staging
# 然后在 Plugins → 安装 bundle 里选择：
#   file:C:/Users/<你>/.dsh/staging/dsh-seesion-copy-enhance-0.2.0.tgz
```

用 `file:` 目录安装只在普通 Windows 路径下有效。包放在 `\\wsl.localhost\...` 这类 UNC 路径上装不上——
pnpm 会把开头的 `\\` 改写掉，报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`；打成 `.tgz` 后 pnpm
会把真实文件复制进 profile，最稳。

### 4. 源码安装

```powershell
git clone https://github.com/JMILI/dsh-seesion-copy-enhance.git
dsh plugin --profile desktop add .\dsh-seesion-copy-enhance
```

改完 `lib/index.js`（Host 半）需要重装包或重启应用；`lib/client.js`（客户端半）随页面刷新生效。

## 工作原理

```
点复制  ──►  客户端：POST /dsh-seesion-copy-enhance/capture { sessionId, seq, text }
             Host：从实时会话日志（ctx.sessions）和附件库（ctx.attachments）读回
                  文字与 base64 媒体
             客户端：把 { text/plain, text/html } 写入剪贴板
粘贴    ──►  客户端：在 text/html 里看到媒体 token
             Host：POST /resolve 返回整包（本页已忘记时）
             客户端：createDrafts() → addAttachments() → insertText()
```

* **Host 半**（`lib/index.js`）在 `ctx.webServer` 上注册四个同源路由：`GET /health`、
  `GET /inspect`、`POST /capture`、`POST /resolve`。数据全部来自现有服务，不落盘、不改 schema；
  带外部 `Origin` 的请求一律 `403 cross-origin`。
* **客户端半**（`lib/client.js`）在 `conversation.composer.dock` 挂一个不可见组件，
  拿到当前会话的 `sessionId` 与输入框的 `inputActions`，然后在 document 捕获阶段监听复制与粘贴。
* 媒体不以 URL 形式离开内存：剪贴板自带全部数据，所以跨会话、刷新后、跨窗口粘贴都有效。

## 环境要求

* DSH Web UI 0.2.x（桌面版同一套 UI，同样可用）。
* 可用的剪贴板安全上下文：`http://127.0.0.1`、`http://localhost` 都算。

## 配置

全部可选，写在 `cordis.patch.yml` 的插件条目下：

```yaml
- insert:
    - id: seesion-copy-enhance
      name: 'dsh-seesion-copy-enhance'
      config:
        maxAttachmentBytes: 25165824   # 单个附件超过此大小跳过
        maxBundleBytes: 25165824       # 整条消息的上限
        history: 32                    # 内存中保留多少条可再次解析的消息
```

被跳过的附件会出现在响应的 `warnings` 里并打印到浏览器控制台，其余内容照常复制。

## 本机实测记录（2026-11-03，DSH `0.2.1-rc.5`）

| 检查项 | 结果 |
| --- | --- |
| `GET /health` | `200 {"ok":true,"version":"0.2.0",...}` |
| `GET /inspect` | 200，2 个会话、10 / 267 条用户消息的形状 |
| `POST /capture`（8 张截图的真实消息） | 8 个 PNG，字节 1354080 / 2025508 / 1203138 / 216053 / 38122 / 319601 / 52797 / 240416，**逐个与 `bytes` 字段一致**，`warnings: []` |
| 同一 payload 的文本 | 859 字符，与消息正文一致 |
| `POST /resolve`（token） | 文本与 8 个附件的 base64 **逐字节相同** |
| `POST /resolve`（纯文本回退） | 文本相同，附件 8 个 |
| 跨站请求（伪造 `Origin`） | `403 {"ok":false,"error":"cross-origin"}` |
| 客户端注册 | `conversation.composer.dock` 占位 `dsh-seesion-copy-enhance`，order 60，`active: true` |

复跑：`powershell -File verify.ps1`（有 PowerShell 7 用 `pwsh -File verify.ps1`；加 `-Capture`
会额外做媒体往返校验）。脚本是纯 ASCII，Windows PowerShell 5.1 也能直接跑。

### 手动验收（30 秒）

1. 在任意会话里找到一条**带图片**的用户消息，点它右下角的复制按钮 → 右下角出现
   `已复制文字 + N 个附件，可粘贴到任意会话`。
2. 打开另一个会话（或同一会话）的输入框，`Ctrl+V` → 输入框里出现原文文字 + N 个附件卡片。
3. 按 `Enter` 发送 → 新消息里图片照常显示。

## 隐私与安全

* 桥接路由只接受同源请求；`/inspect` 只返回"形状"（会话 id、消息 seq、文字长度、block 类型），
  不会把消息正文带出会话。
* 捕获的整包数据只存在 Host 内存里（默认最近 32 条），插件卸载或宿主重启即消失，不写磁盘。
* 剪贴板由你自己触发写入；插件不读取、不上传剪贴板内容到任何外部服务。

## 已知边界

* 复制的是"消息里真实存在的附件"，已被 Host 清理掉的附件无法恢复。
* 默认对单附件与整包各设 24 MB 上限，保证剪贴板写入不卡顿；经常搬大视频可以调高。
* 复制的是消息原文，不是渲染后的 markdown。
* 视频/音频作为普通文件卡片往返，不在输入框里内联预览（DSH 输入框本身也不内联预览）。

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 提示"已复制文字（这条消息没有附件）" | 这条消息本来就没有附件 | 正常 |
| 提示"已复制文字（未取到附件）" | 复制请求失败或宿主缺少附件读取能力 | 看控制台 `[dsh-seesion-copy-enhance]`，或查 `/health` 的 `capabilities` |
| 提示"无法写入剪贴板" | 浏览器拒绝了剪贴板权限 | 点一下页面再试，检查剪贴板权限设置 |
| 粘贴只有文字 | 中间应用把 token 丢了 | 从 DSH 重新复制；DSH→DSH、DSH→富文本都能保留 |
| 没有出现附件卡片 | 输入框当时在锁定状态（adjudicating/submitting） | 等发送按钮空闲后再粘贴 |
| 路由 404 | Host 半没加载（改完没重装） | 重装 `.tgz` 或重启应用 |

调试时可以直接探测 Host 路由：

```powershell
curl http://127.0.0.1:<GUI-port>/dsh-seesion-copy-enhance/health
curl http://127.0.0.1:<GUI-port>/dsh-seesion-copy-enhance/inspect
```

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。没有构建步骤：`lib/client.js` 就是浏览器直接加载的文件，
改完刷新页面即可；`lib/index.js` 改完需要重装包。

## 许可证

MIT，见 [LICENSE](LICENSE)。
