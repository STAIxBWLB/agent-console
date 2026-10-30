# agent-console

- Implement the accepted issue contract on a branch with a PR. The plan of record is entelecheia/ai-workspace#60 Part 2, and the UX spec is STAIxBWLB/vault-mem#48.
- Source is in `src/`, the browser shell in `shell/` (no build step), the bootstrap in `bin/`, checks in `scripts/`, tests in `test/`.
- Use strict TypeScript, `.ts` imports and `noUncheckedIndexedAccess`. Runtime imports are builtins and relative files only; `bun scripts/check-boundary.ts` enforces this.
- Shell and panel code runs under `default-src 'none'` with `'self'` scripts and styles: no inline scripts, no `style=` attributes, no `innerHTML` with data, nothing from another origin. Render data as text.
- Contract api 1 changes are additive only. Destructive or outward plugin actions answer `needsConfirm`; never let the page set `confirmed` or `fingerprint`.
- Do not add agent-environment refusal or TTY requirements. Keep unimplemented modes (H1 `acon serve`, H2 static build) out of the CLI and README claims.
- Run `bun install --frozen-lockfile`, then `bun run check`. Passing output includes `boundary: ok`, all tests passing and a package dry-run.
- Use conventional English commits without coauthor trailers unless requested.
