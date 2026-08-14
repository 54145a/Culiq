# Curio

> Radical Fork of Curio that aims to create an extendable browser agent platform

A browser-extension browser agent that automatically operates the browser for you — opening pages, reading content, clicking buttons, filling forms, running JavaScript, and doing basic reverse engineering. Supports Chrome, Edge, and Firefox.

### Features

- Sidebar chat with streaming output, Markdown rendering, and collapsible tool-call cards
- Light / dark theme toggle; the theme preference is saved automatically
- Multi-session management: create, switch, delete; survives refresh
- Agent tools:
  - `navigate` — open a URL and wait for it to finish loading
  - `read_dom` — read page content in text / HTML / structural-outline modes
  - `screenshot` — capture the active tab's visible viewport for vision-capable models to analyze images, canvas, charts, layout, and visual state
  - `query` — locate elements by CSS selector, returning tag, attributes, text, position, and more
  - `click` — click an element, auto-scrolling into view
  - `type` — type text into an input, textarea, or contenteditable
  - `eval_js` — run JavaScript in the MAIN or ISOLATED world to access page globals, framework state, or hook fetch / XHR
  - `list_tabs` — list all open tabs (id / url / title / active state)
  - `switch_tab` — activate a tab by id and focus its window
  - `reload_tab` — reload a tab, optionally bypassing the cache
  - `fetch_url` — one-shot read of a URL's rendered content (text / HTML) in a foreground tab, then close it; for API endpoints and static pages, not for interactive browsing (use `navigate` + DOM tools); if the URL responds with a file download, it will only trigger the download and return nothing
- **Skills system** (AgentSkills-compatible): a skill is `SKILL.md` instructions plus optional script files (any language); the system prompt injects an `<available_skills>` index, and `use_skill` accesses skills like a filesystem — index first (truncated instructions + file listing), then read individual files via the `file` parameter. User skills can be imported from a local folder
- **`sandbox_exec` sandbox** — runs JavaScript in a restricted Worker (no chrome.*), exposing `sandbox.fs` (OPFS private filesystem: read / write / list / delete / mkdir), `sandbox.fetch` (extension-origin, CORS-free), a whitelisted chrome bridge `sandbox.chrome.tabs.*` (including create/duplicate) / `sandbox.chrome.windows.*`, and `sandbox.evalInTab(tabId, world, code)` / `sandbox.evalInAllFrames` (pierces iframes; combine with `sandbox.fs` to store page content); for file work, patching, write-capable skills, and computation — instead of stacking dedicated tools
- **MCP client** — connect to Model Context Protocol servers (Streamable HTTP or legacy SSE) in **Settings → MCP servers**; their tools are exposed to the agent as `server-tool` and toggle per server. The URL must include the server's endpoint path (e.g. `…/mcp` for HTTP, `…/sse` for SSE). A broken server surfaces as a `server-__connection_error` diagnostic tool instead of failing silently.
- Supports OpenAI Chat Completions and Anthropic Messages compatible APIs (DeepSeek, Moonshot, etc.)
- Automatic context compression: automatically summarizes the oldest turns as the conversation nears the model's context window, keeping the recent conversation verbatim to avoid exceeding the context limit on long sessions
- Pure add-on form; operates directly on the current page

### Implementation

- **Side panel** — chat UI in vanilla TypeScript + Vite + marked; the settings page uses Preact (Vite-native esbuild JSX, `jsxImportSource: preact`)
- **Service worker** — the agent loop streams the LLM; provider differences are unified by the Vercel AI SDK (`streamText` + `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic`, including DeepSeek reasoning and Anthropic thinking signatures), dispatches tool calls, and captures the active tab's visible viewport in the background
- **Context compression** — estimates per-turn token usage (tokenx) inside the agent loop; past the context-window threshold, the oldest turns are handed to the LLM for summarization while the most recent turns stay verbatim, preserving AI / tool-result pairing
- **Content script** — injected into all pages, performs DOM operations (query / click / type / read_dom)
- **Page execution worlds** — on-demand `chrome.scripting.executeScript` in the MAIN or ISOLATED world so `eval_js` can access page globals, framework state, or an isolated DOM environment
- **Skills** — user skills are imported from a local folder into **OPFS** (Origin Private File System, extension-private and origin-scoped; `skills/<name>/SKILL.md` + files), with metadata (enabled, etc.) in `chrome.storage.local`; `use_skill` accesses skill files like a virtual filesystem (index first, then on-demand reads with truncation); script sources are not executed yet and are for reference only
- **Sandbox** — `sandbox_exec` runs agent-provided JS in a dedicated Worker loaded from a static extension file (no chrome.*, least privilege); the sandbox exposes OPFS (`sandbox.fs`), `sandbox.fetch`, and the whitelisted chrome bridge (worker-side proxy → postMessage → the SW runs the real chrome.* with whitelist + argument validation). API declarations are injected into the system prompt as a compact .d.ts; `sandbox.docs(name)` returns details on demand. The worker persists within a turn (terminates when the SW suspends), and cross-turn state lives in OPFS. Chrome MV3 service workers cannot create Workers, so there the worker runs inside an offscreen document that relays messages to the SW; Firefox backgrounds can spawn it directly.

### Installation

#### 1. Download a release

Find the artifact for your browser on the [Releases](../../releases) page:

- Chrome / Edge: `curio-vX.Y.Z-chrome.zip`
- Firefox (128+): `curio-vX.Y.Z-firefox.xpi`

##### Chrome / Edge

1. Unzip the archive to any directory
2. Open `chrome://extensions` (`edge://extensions` for Edge), enable Developer mode in the top-right
3. **Load unpacked** → select the directory
4. Click the Curio icon in the toolbar to open the sidebar

##### Firefox

Import the `.xpi` file directly from `about:addons`.

#### 2. Build from source

```bash
git clone https://github.com/54145a/Curio.git
cd Curio
corepack enable        # enable pnpm (or install pnpm yourself)
pnpm install
pnpm run build         # produces dist-chrome/ and dist-firefox/
# or build individually:
# pnpm run build:chrome
# pnpm run build:firefox
```

Load the unpacked extension: use `dist-chrome/` in Chrome, or `about:debugging#/runtime/this-firefox` → `dist-firefox/manifest.json` in Firefox.

### Configuration

Configure providers in the sidebar **Settings**:

| Provider | Default model | base URL |
| --- | --- | --- |
| OpenAI | `gpt-4o-mini` | custom |
| Anthropic | `claude-sonnet-4-5-20250929` | custom |

Fill in the API key, adjust the base URL or Model ID as needed, and Save. Click a provider card to activate it. OpenAI Chat Completions or Anthropic Messages compatible endpoints (DeepSeek, Moonshot, local vLLM, etc.) can be reached by changing the base URL. Screenshots require a model and endpoint with vision support. API keys are stored in `chrome.storage.local` and are only sent to the LLM API.

**Context management**: when the conversation nears the model's context window, the oldest turns are summarized automatically and the recent conversation stays verbatim, avoiding overflow on long sessions. Configure in **Settings → Context management**:

- **Context window (tokens)** — your model's context window size; a conservative default is used if left empty
- **Trigger at (% of context window)** — the ratio that triggers compression, default 70%
- **Keep recent turns verbatim** — complete recent turns kept when compressing, default 4

**Skills**: manage skills in **Settings → Skills**. The extension ships with no built-in skills. Import options:

- **Import skill folder…** — select a local folder containing `SKILL.md` (AgentSkills format; frontmatter requires `name` and `description`) and optional script files; scripts may be in any language.
- **Download skill from current tab** — if the active tab is a ClawHub skill page (`clawhub.ai/<owner>/skills/<slug>`), download the skill's zip locally, then unzip and import it with the folder import above.

User skills can be enabled / disabled or deleted individually. Imported scripts are not executed and are surfaced to the model for reference only via `use_skill`; to modify skill files (patch, write content), the model can read/write OPFS directly through `sandbox_exec`'s `sandbox.fs` (e.g. `sandbox.fs.write("skills/<name>/SKILL.md", content)`). Treat third-party skills as untrusted code and review them before importing.

**MCP servers**: manage in **Settings → MCP servers**. Add a server by name + URL + transport (Streamable HTTP or legacy SSE) and enable it; its tools appear to the agent as `server-tool`. **Test** verifies connectivity and reports the exposed tool count. Each turn opens a fresh connection to enabled servers and closes it when the turn ends. MCP servers are third-party code that may have external side effects — only enable servers you trust.

### License

MIT
