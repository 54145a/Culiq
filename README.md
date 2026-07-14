# Curio

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
- 支持 OpenAI Chat Completions 和 Anthropic Messages 兼容 API（如 DeepSeek、Moonshot）
- 纯插件形式，可以直接操作当前界面

### 实现

- **Side panel** —— 对话 UI，原生 TypeScript + Vite + marked
- **Service worker** —— agent loop，用 `fetch` 流式调用 LLM（Anthropic Messages / OpenAI Chat Completions），解析 SSE，分发 tool call，并在后台截取当前标签页的可见区域
- **Content script** —— 注入到所有页面，承担 DOM 操作（query / click / type / read_dom）
- **Page execution worlds** —— 按需通过 `chrome.scripting.executeScript` 在 MAIN 或 ISOLATED world 执行代码，让 `eval_js` 访问页面 globals、框架内部状态或隔离的 DOM 环境

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
git clone https://github.com/void5tar/Curio.git
cd Curio
npm install
npm run build           # 同时产出 dist-chrome/ 和 dist-firefox/
# 或单独构建：
# npm run build:chrome
# npm run build:firefox
```

加载已解压的扩展程序，Chrome 选 `dist-chrome/`，Firefox 用 `about:debugging#/runtime/this-firefox` 选 `dist-firefox/manifest.json`。

### 配置

在侧边栏 **Settings** 中配置服务商：

| 服务商 | 默认模型 | base URL |
|---|---|---|
| OpenAI | `gpt-4o-mini` | 可自定义 |
| Anthropic | `claude-sonnet-4-5-20250929` | 可自定义 |

填入 API key，按需修改 base URL 或 Model ID，Save 保存。点击服务商卡片切换激活项。可以通过修改 base URL 接入 OpenAI Chat Completions 或 Anthropic Messages 兼容端点（DeepSeek、Moonshot、本地 vLLM 等）。截图功能要求所选模型和端点支持视觉输入。API key 保存在 `chrome.storage.local`，除了请求 LLM API 不会发到其他地方。

### License

MIT
