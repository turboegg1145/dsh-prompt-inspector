# dsh-prompt-inspector

**Prompt Inspector for DeepSeek Harness** — see and trim everything injected before a conversation: every system-prompt section, every context block, every tool schema, each with a token estimate.

**DSH 提示词体检** — 逐条查看并裁剪对话前注入的系统提示词、上下文块与工具 schema，附 token 估算。

---

## 它解决什么

新开一个对话时，Harness 会先注入一大坨东西：系统提示词分段、工作目录/沙箱/审批等上下文块、以及几十个工具的 schema。这些都在你打字之前就吃掉了 input token，但平时完全看不见。

这个插件在输入框右侧加了一个「提示词」按钮，点开是一个右侧抽屉：

| 部分 | 内容 |
|---|---|
| 系统提示词分段 | 名称、顺序、token 数，展开看已插值的完整文本 |
| 上下文块 | 工作目录、沙箱策略、审批策略等 |
| 工具 schema | 每个工具的描述与参数 JSON、单个体积 |
| 合计 | 三部分分开统计，一眼看出谁最贵 |

本机实测一个典型会话：23 段提示词 ≈ 1.8k token，7 个上下文块 ≈ 80 token，43 个工具 ≈ 9.5k token。**大头通常是工具 schema，不是提示词正文** —— 想省 input token，先砍工具。

## 它能改什么

- **改文本**：任意分段「编辑」→「保存并应用」，用同名 section 覆盖，并保持原来的顺序位置；「静音」把该段置空；「还原」恢复原文。
- **藏工具**：取消勾选即从后续请求中移除（`tools.restrict`）。合计只统计仍然可见的工具，被藏的工具划线显示并标注 `−X`。
- **全部还原**：清空该会话的所有修改。

修改只影响之后的请求，历史对话不受影响；状态按会话保存，重载插件后清空。

## 安装

要求 DeepSeek Harness `0.2.x`（Web profile）。

```
plugin_manager install_bundle  target=https://github.com/turboegg1145/dsh-prompt-inspector
```

也支持 tarball / 本地目录：

```
plugin_manager install_bundle  target=https://github.com/turboegg1145/dsh-prompt-inspector/archive/refs/heads/main.tar.gz
plugin_manager install_bundle  target=/绝对路径/dsh-prompt-inspector
```

装完刷新页面，输入框右侧出现「提示词」按钮。若某个会话还没开始（没有 live agent），抽屉会提示先发一条消息。

## 实现要点

- Host 侧注册 `webServer` 前缀路由 `/prompt-inspector`：`GET /ping`、`GET /snapshot?session=`、`POST /apply`、`POST /reset`。
- 这条路由挂在裸 webserver 上，不走 harness `/api` 的 Host/Origin 围栏，所以四个端点共用一道自己的围栏：`Host` 必须是本机回环且端口等于监听端口（挡 DNS rebinding），`Sec-Fetch-Site` 只接受 `same-origin`/`none`，带 `Origin` 时必须与 `Host` 同源，并要求 `x-prompt-inspector: 1` 请求头（挡 `no-cors` 跨站 POST）。手工 curl 时记得带上：`-H 'x-prompt-inspector: 1'`。
- `snapshot` 用 `ctx.systemPrompt.assemble({ scope: agent })` 取合并后的真实装配结果（agent 对象本身就是 ScopeKey），再按 `layers.merge()` 里的真实 `order` 建立同名覆盖段。
- token 估算沿用 harness 的启发式：`ceil(字符数 / 4)`。
- 编辑走 `agent.ctx.systemPrompt.section()`（同名覆盖，不改 `system-prompt/assemble` 瀑布），隐藏走 `agent.ctx.tools.restrict({ deny })`；两者都随 agent 生命周期自动回收。
- 客户端是纯 React 的 `shell.overlay` 抽屉 + `conversation.input.right` 触发按钮，配色只用 `--dsw-alias-*` 主题变量，无第三方依赖。

## 结构

```
package.json        dsh.bundle.patch / dsh.client / dsh.install
cordis.patch.yml    bundle 插入行
index.js            Host 半：HTTP 路由 + 装配快照 + 应用编辑
client.js           Client 半：触发按钮 + 抽屉
locale/{zh,en}.json 界面文案
icon.svg            插件图标
```

## License

MIT
