# AGENTS.md — Rules for AI coding agents

## Critical: Never push without explicit permission

Do NOT run `git push` or create PRs unless the user explicitly asks. Even if the user says "commit", that means local commit only. Always wait for the user to say "push" before pushing to remote.

Accidental pushes can leak secrets, internal APIs, or unfinished code to public repositories. This is irreversible.

## Tooling

- **Package manager:** pnpm (never npm)
- **Linter:** `pnpm lint` (oxlint with type-aware rules)
- **Type check:** `pnpm check` (tsc --noEmit, three tsconfigs)
- **Build:** `pnpm build` (Chrome + Firefox targets)

## Code conventions

- TypeScript strict, Preact for UI, Vite for bundling
- MV3 Chrome/Firefox extension
- No comments unless asked
- Reuse existing patterns before writing new code
