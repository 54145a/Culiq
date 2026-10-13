# AGENTS.md — Rules for AI coding agents

## Critical: Never push without explicit permission

Do NOT run `git push` or create PRs unless the user explicitly asks. Even if the user says "commit", that means local commit only. Always wait for the user to say "push" before pushing to remote.

Accidental pushes can leak secrets, internal APIs, or unfinished code to public repositories. This is irreversible.

## Tooling

- **Package manager:** pnpm (never npm)
- **Linter:** `pnpm lint` (oxlint with type-aware rules)
- **Type check:** `pnpm check` (tsc --noEmit, three tsconfigs)
- **Build:** `pnpm build` (Chrome + Firefox targets)
- CI runs lint + check only on the chrome target

## Code conventions

- TypeScript strict, Preact for UI, Vite for bundling
- MV3 Chrome/Firefox extension
- No comments unless asked
- Reuse existing patterns before writing new code

## Architecture (agent must know)

**Extension structure:** side panel (chat UI) → service worker (agent loop, tool dispatch) → content script (DOM ops) + sandbox iframe (eval).

**Sandbox (`sandbox-frame.js`):** Runs in a sandboxed iframe (opaque-origin, no `chrome.*`). All operations bridge to the SW via `postMessage`. The sandbox object has custom implementations for `file()`, `dir()`, `write()`, `tree()`, `fetch()` — **do not overwrite these in `buildShims`**; top-level paths that already exist on `sess.sandbox` must be skipped.

**`BRIDGE_SPEC`** (in `src/shared/agent/tools/sandbox/api.ts`): single source of truth for all sandbox bridge methods. The `bridge()`, `internalBridge()`, `ns()` helpers reduce boilerplate. `response.*` methods are internal (called via Proxy, not directly by agent code).

**Custom tools:** single `.js` file with `export default { name, description, parameters, execute(sandbox, input) }`. Metadata extracted via acorn (no eval). Full module source sent to sandbox for execution. Built-in tools sync from `public/custom-tools/` to OPFS on startup.

**`fetch_url`** composes `navigate` + `read_dom` (no direct `chrome.tabs` API from the tool itself). In standalone/popup mode, it detects this internally and handles tab switching.

**Session storage:** `chrome.storage.local` key `culiq.sessions.v2`. Single blob `Record<string, Session>`. Tool result messages are stripped of non-text blocks before persisting.

**Message content model:** assistant messages hold two kinds of blocks. Provider content (`text`, `thinking`, `toolCall`) is the only thing that maps to LLM messages. Display-only blocks (`context`, `usage`, `error`, `compress`, `subtask`, `bridgeCall`) render as UI cards and must never be stored as or converted into provider content — providers reject an assistant message with no content and no tool calls (HTTP 400), which poisons every subsequent send. Sandbox bridge calls (`sandbox.fetchUrl`, `sandbox.tabs.query`, ...) are display-only: `handleBridge` emits `bridge_execution_start/end` events → `agentEventToChunk` maps them to `data-bridge` parts → they persist as `bridgeCall` blocks. They are NOT LLM tool calls (their dotted names and array arguments would be rejected by the provider).

**Send-time context:** the current page / open tabs are appended to the last user message (in the message flow), not injected into the system prompt.

## Key files

- `src/shared/agent/tools/sandbox/api.ts` — BRIDGE_SPEC, sandbox types, d.ts generation
- `src/shared/agent/tools/sandbox/sandbox-exec.ts` — evaluate(), handleBridge()
- `src/shared/agent/tools/browser/` — navigate, fetch_url, dom, wait, screenshot, etc.
- `src/shared/custom-tools/` — types, storage, build, parse (acorn)
- `src/shared/opfs.ts` — opfs-tools wrapper with `assertSafePath`
- `src/sidepanel/main.tsx` — iframe setup, message relay
- `src/background/service-worker.ts` — handleChat, syncBuiltinTools, findTargetTab
- `public/sandbox-frame.js` — sandbox host (separate context, not a module)
