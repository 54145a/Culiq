# Curio

> Radical Fork of Curio that aims to create an extendable browser agent platform

一个浏览器扩展形式的 browser agent，能够自动帮你操作浏览器，比如打开网页、读取内容、点击按钮、填写表单、执行 JavaScript，以及进行基本的逆向分析。支持 Chrome、Edge 和 Firefox。

### 功能特性

- 侧边栏聊天，流式输出，Markdown 渲染，工具调用以可折叠卡片展示
- 支持亮色 / 暗色主题切换，主题偏好会自动保存
- 多会话管理：创建、切换、删除，刷新后保留
- Agent 工具：
  - `navigate` —— 打开 URL 并等待加载完成
  - `read_dom` —— 读取页面内容，支持文本 / HTML / 结构大纲三种模式
  - `screenshot` —— 截取当前标签页的可见区域，让支持视觉输入的模型分析图片、画布、图表、布局和视觉状态
  - `query` —— 通过 CSS 选择器查询元素，返回 tag、属性、文本、位置等
  - `click` —— 点击元素，自动滚动到视野内
  - `type` —— 在 input、textarea、contenteditable 中输入文本
  - `eval_js` —— 在 MAIN 或 ISOLATED world 执行 JavaScript，可以访问页面 globals、框架状态或 hook fetch / XHR
  - `list_tabs` —— 列出所有打开的标签页（id / url / title / 激活状态）
  - `switch_tab` —— 按 id 激活标签页并聚焦对应窗口
  - `reload_tab` —— 刷新标签页，可选强制绕过缓存
  - `fetch_url` —— 一次性读取 URL 的渲染内容（文本 / HTML），前台标签加载后关闭；适用于 API / 静态页，不适用于需要交互的页面浏览（请用 `navigate` + DOM 工具），若 URL 返回文件下载则只会触发下载而不返回内容
- **Skills 技能系统**（AgentSkills 规范兼容）：技能 = `SKILL.md` 指令 + 可选脚本文件（语言不限）；系统提示注入 `<available_skills>` 索引，`use_skill` 以文件系统方式访问技能——先返回索引（截断指令 + 文件清单），再按 `file` 参数逐文件读取。支持从本地文件夹导入用户技能
- **`sandbox_exec` 沙箱** —— 在受限 Worker（无 chrome.*）里执行 JavaScript，暴露 `sandbox.fs`（OPFS 私有文件系统：读/写/列/删/建目录）、`sandbox.fetch`（扩展源免 CORS 网络）、白名单 chrome 桥 `sandbox.chrome.tabs.*`（含 create/duplicate）/ `sandbox.chrome.windows.*`、`sandbox.evalInTab(tabId, world, code)` 与 `sandbox.evalInAllFrames`（穿透 iframe；配合 `sandbox.fs` 可把页面内容存盘）；用于文件操作、打补丁、写内容的技能与计算，替代堆叠专用工具
- **MCP 客户端** —— 在 **Settings → MCP servers** 中连接 Model Context Protocol 服务器（Streamable HTTP 或旧式 SSE）；其工具以 `server-tool` 形式暴露给 Agent，并按服务器单独启停。URL 必须包含服务器的端点路径（HTTP 用 `…/mcp`，SSE 用 `…/sse`）。连接失败的服务器会暴露为 `server-__connection_error` 诊断工具而非静默失败
- 支持 OpenAI Chat Completions 和 Anthropic Messages 兼容 API（如 DeepSeek、Moonshot）
- 自动上下文压缩：对话接近模型上下文窗口时自动摘要最旧的轮次、保留最近的对话原文，避免长会话超出上下文限制
- 纯插件形式，可以直接操作当前界面

### 实现

- **Side panel** —— 对话 UI，原生 TypeScript + Vite + marked；设置页用 Preact（Vite 原生 esbuild JSX，`jsxImportSource: preact`）
- **Service worker** —— agent loop 流式调用 LLM；Provider 差异由 Vercel AI SDK（`streamText` + `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic`）统一处理（含 DeepSeek reasoning 与 Anthropic thinking 签名），分发 tool call，并在后台截取当前标签页的可见区域
- **上下文压缩** —— agent loop 内按 turn 估算 token 用量（tokenx），超过上下文窗口阈值时把最旧的轮次交给 LLM 摘要，保留最近的轮次原文，保证 AI / tool result 消息配对完整
- **Content script** —— 注入到所有页面，承担 DOM 操作（query / click / type / read_dom）
- **Page execution worlds** —— 按需通过 `chrome.scripting.executeScript` 在 MAIN 或 ISOLATED world 执行代码，让 `eval_js` 访问页面 globals、框架内部状态或隔离的 DOM 环境
- **Skills** —— 技能由用户从本地文件夹导入存入 **OPFS**（Origin Private File System，扩展私有、origin 隔离；`skills/<name>/SKILL.md` + 文件），元数据（enabled 等）存 `chrome.storage.local`；`use_skill` 以虚拟文件系统方式访问技能文件（先索引、再按需读取单个文件，读取可截断），脚本源码暂不执行、仅供模型参考
- **Sandbox** —— `sandbox_exec` 在从静态扩展文件加载的专用 Worker（无 chrome.* 最小权限）中执行 Agent 提供的 JS；沙箱暴露 OPFS（`sandbox.fs`）、`sandbox.fetch` 与白名单 chrome 桥（Worker 侧代理 → postMessage → SW 执行真实 chrome.*，白名单 + 参数校验）。API 声明以紧凑 .d.ts 注入 system prompt，`sandbox.docs(name)` 按需返回详情；Worker 单 turn 内持久（SW 挂起即终止），跨 turn 状态落到 OPFS

### 安装

#### 1. 下载 release

在 [Releases](../../releases) 页面找到对应浏览器的产物：

- Chrome / Edge：`curio-vX.Y.Z-chrome.zip`
- Firefox（128+）：`curio-vX.Y.Z-firefox.xpi`

##### Chrome / Edge

1. 解压 zip 到任意目录
2. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），启用右上角开发者模式
3. **加载已解压的扩展程序** → 选择解压目录
4. 点击工具栏的 Curio 图标打开侧边栏

##### Firefox

直接在 `about:addons` 导入 `.xpi` 文件即可安装扩展

#### 2. 从源码构建

```bash
git clone https://github.com/54145a/Curio.git
cd Curio
corepack enable        # 启用 pnpm（或自行安装 pnpm）
pnpm install
pnpm run build         # 同时产出 dist-chrome/ 和 dist-firefox/
# 或单独构建：
# pnpm run build:chrome
# pnpm run build:firefox
```

加载已解压的扩展程序，Chrome 选 `dist-chrome/`，Firefox 用 `about:debugging#/runtime/this-firefox` 选 `dist-firefox/manifest.json`。

### 配置

在侧边栏 **Settings** 中配置服务商：

| 服务商 | 默认模型 | base URL |
| --- | --- | --- |
| OpenAI | `gpt-4o-mini` | 可自定义 |
| Anthropic | `claude-sonnet-4-5-20250929` | 可自定义 |

填入 API key，按需修改 base URL 或 Model ID，Save 保存。点击服务商卡片切换激活项。可以通过修改 base URL 接入 OpenAI Chat Completions 或 Anthropic Messages 兼容端点（DeepSeek、Moonshot、本地 vLLM 等）。截图功能要求所选模型和端点支持视觉输入。API key 保存在 `chrome.storage.local`，除了请求 LLM API 不会发到其他地方。

**Context management**：当对话接近模型的上下文窗口时，自动把最旧的轮次摘要化、保留最近的对话原文，避免长会话超出限制。在 **Settings → Context management** 中配置：

- **Context window (tokens)** —— 所用模型的上下文窗口大小，留空则使用保守默认值
- **Trigger at (% of context window)** —— 触发压缩的比例，默认 70%
- **Keep recent turns verbatim** —— 压缩时保留的最近完整轮次，默认 4

**Skills**：在 **Settings → Skills** 中管理技能。扩展默认不内置任何技能。导入方式：

- **Import skill folder…** —— 从本地选择包含 `SKILL.md`（AgentSkills 格式，frontmatter 需含 `name` 与 `description`）和可选脚本文件的文件夹导入，脚本语言不限。
- **Download skill from current tab** —— 若当前标签页是 ClawHub 技能页（`clawhub.ai/<owner>/skills/<slug>`），下载该技能的 zip 到本地，解压后可用上面的文件夹导入安装。

用户技能可单独启用 / 禁用或删除。导入的脚本暂不执行，仅随 `use_skill` 逐文件提供给模型参考；如需对技能文件施加修改（打补丁、写内容），模型可通过 `sandbox_exec` 的 `sandbox.fs` 直接读写 OPFS（如 `sandbox.fs.write("skills/<name>/SKILL.md", content)`）。第三方技能视为未信任代码，导入前请先审阅。

**MCP servers**：在 **Settings → MCP servers** 中管理。按「名称 + URL + 传输层（Streamable HTTP 或旧式 SSE）」添加服务器并启用，其工具即会以 `server-tool` 形式提供给 Agent；**Test** 可验证连通性并显示暴露的工具数量。每轮对话开始时为已启用的服务器建立全新连接、结束时关闭。MCP 服务器是可能有外部副作用的第三方代码，请只启用你信任的服务器。

### License

MIT
