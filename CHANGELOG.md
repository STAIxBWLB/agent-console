# Changelog

## [Unreleased]

### Added

- Local Mac first, other Macs over the Cloudflare WARP mesh (#65). `--origin` accepts `http://` for WARP device addresses in `100.64.0.0/10`. A bearer node has a script-free `/login` form; the token typed there gets a 12-hour `HttpOnly; SameSite=Strict` session cookie that stands for the token, and a browser opening `/` unauthenticated is redirected to it (other callers keep the 401). Access and loopback nodes are unchanged. The README shows a loopback agent for this Mac plus a bearer agent on the WARP address.
- README freshness (#67): `scripts/readme-facts.ts` renders the README's package, producer and command facts from `package.json`, `src/contract.ts` and `src/cli.ts`, and `bun run check` fails when a block differs (`--write` rewrites them). `docs/verified.json` records the commit each document was last reviewed against; `scripts/check-docs.mjs` reports stale documents on every check and refuses a release with `--require-fresh`. A successful release notifies STAIxBWLB/agent-hub-site when `SITE_DISPATCH_TOKEN` is set.

### Fixed

- The README lists agent-mem and agent-research among the tools that register plugins, and the 0.1.1 entry no longer contradicts the README on the hosted static-shell readback (#67).

## [0.1.4] - 2026-11-05

### Fixed

- The static shell reports a request that hits its own deadline as **slow** ("the node is reachable but busy"), not as "refused (origin)". A slow node stays usable: it counts as online, with a "slow" note in the status chip, and its next request is still sent. Only a network failure with a reachable health probe is reported as "refused (origin)" (#59).
- Inbox polling keeps at most one snapshot in flight per tool. A tick shares a slow tool's pending request. An explicit refresh waits for it and then polls once, and every caller waiting on the same request shares that poll. Slow providers no longer pile up requests every 5 s (#60).

## [0.1.3] - 2026-11-04

### Fixed

- `acon setup launchd --apply` waits up to 10 s for `launchctl bootout` to finish before `bootstrap`, which failed with error 5 when it replaced a running agent (#56).
- The plist keeps the PATH `bun` link (such as `/opt/homebrew/bin/bun`) when it is the running binary instead of the versioned Cellar file that `brew upgrade` removes (#56).
- `acon build --static` writes `compatibility_date` 2026-10-01, which recent wranglers support (2026-11-04 was refused). It also adds `.vercelignore`, so Vercel no longer serves `wrangler.jsonc`, `.assetsignore` or `_headers` (#55).
- The README notes that the first Vercel or Workers deploy of a new project can be a production deployment (#55).

## [0.1.2] - 2026-11-04

### Fixed

- The contract no longer references the DOM lib (#52), so consumers compiled with `lib: ["ESNext"]` no longer get DOM globals such as `document`. Panel-side types resolve to the exact DOM types (`HTMLElement`, `HTMLButtonElement`, `HTMLFormElement`, `Node`) when the consumer has the DOM lib, and to the new structural `ConsoleElement` and `ConsoleNode` otherwise. `bun run check` typechecks the contract and conformance without the DOM lib. Types only, with no change for DOM-typed panels.

## [0.1.1] - 2026-11-04

### Added

- H2 static shell (#46): `acon build --static --nodes id=https://origin[,id=origin] [--out dist]`, fixed credential-free assets and Vercel/Workers static config, per-node bearer/Access auth, namespaced tools, node-owned actions and allowlisted credentialed CORS. Node-specific expiring GET-only grants serve authenticated modules/assets without exposing bearer tokens in URLs. Two-node ui-check covers ownership and distinct offline/origin-refused states. Hosted preview readback was not done for this release; it followed with 0.1.3 (#57), and the README's "Static multi-node shell (H2)" section carries the current state.
- H1 follow-ups (#45): `acon serve --read-only` / `ACON_READ_ONLY=1` refuses every plugin action (403 `read-only node`, no plugin call, no confirm token, a replayed token is not honoured), reports `readOnly: true` in `/tools`, and the shell shows a Read-only chip with verb, answer and confirm buttons disabled. `acon token new [--file] [--force]` writes a 0600 base64url bearer token and prints only its path. `acon setup launchd [--label] [--apply]` prints (or installs) a LaunchAgent for `acon serve` with auth passed as env names and file paths. The Dockerfile carries OCI `source` and `revision` labels.
- Release images (#45): behind `IMAGE_PUBLISH_ENABLED`, tagged releases push multi-arch (`linux/amd64`, `linux/arm64`) images to `ghcr.io/staixbwlb/agent-console:<version>` (and `latest` for stable versions) with OCI labels, read the manifest back and run `--version` on amd64.

## [0.1.0] - 2026-11-04

### Compatibility

Initial 0.1.x minor line: N-1 is not applicable because no previous minor has been published.

- Plugin API (#27): a plugin that checks `ctx.features` sends no forms or `result` items to a console before this release, which would report them as malformed; plugins that ignore `meta` are unaffected.

- Plugin API, routes and manifest files (#26): plugins registered for api 1 with a single `<tool>.json` and a plain `"api": 1` load unchanged; `/p/<tool>/...` routes keep working beside the new `/p/<tool>@<hash>/...` refs. Consoles before this release refuse `apiMin`/`apiMax` keys and ignore `<tool>@<version>.json` files (they fail the tool-id check), so a tool that needs both should keep writing `<tool>.json`.

### Fixed

- Plugin discovery scans files that start with a `#!` line (CLI entry files) instead of marking the plugin "cannot be read"; a file that cannot be scanned is now named in the reason. The stripped line ends at any JavaScript line terminator (LF, CR, U+2028, U+2029), so an import after a CR-terminated `#!` is still checked.

### Added

- `host.ui.button(label, onClick, {tone?, disabled?})` (api 1, additive): a `button.btn` with `type="button"` and the `primary` or `danger` modifier. `host.ui.notice` with tone `err` now uses `role="alert"` so errors are announced assertively; other tones keep `role="status"` (#43).
- `host.ui.visual` (api 1, additive): Mermaid diagrams in a `sandbox="allow-scripts"` frame with its own CSP (no `connect-src`), lazy and reused per panel, falling back to the source text on error, over 20 KB or after 5 s; comparison cards; tables through `ui.table`; before/after with text or asset sides. Mermaid is vendored from `@mermaid-js/tiny` 12.2.0 (2.8 MB) with a hash manifest and `scripts/vendor-mermaid.ts --check` (#29).
- `host.ui.review` (api 1, additive): text, prose and diff review with range selection by pointer or keyboard, anchors with `lineRange`, `textQuote` and (diffs) `diffHunk`/`side`, placement by hash then unique quote, an unplaced strip and chunked rendering up to 20,000 lines. Contract types `ReviewSelector`, `ReviewAnchor`, `ReviewThread`, `ReviewDoc`; conformance `reviewProblems`; shared cases in `test/fixtures/review/` ship with the package (#28).
- Inbox choice answers and results (#27): `ctx.features` (`inbox.form`, `inbox.result`, `action.meta`); verb `form` with 1-4 choice questions, an "Other" text, a review step and drafts kept across a refused answer; a `result` group with `seen` receipts after the body end was in view for 1 s in a focused window, and "Mark all read"; `action(input, meta)` with the verified identity; `verbFormProblems` and feature checks in conformance.

- Staged plugin upgrades (#26): `apiMin`/`apiMax` ranges, versioned registrations `plugins/<tool>@<version>.json` (newest loadable wins), a re-scan at most every 5 s that serves a new registration to pages opened after it while open pages keep their load until restart, and `scripts/install-release.ts` for immutable `console/releases/<version>-<commit>/` installs with `current` and `previous` links.
- Plugin assets (api 1, additive): optional `provider.asset({id})`, served at a session-gated `GET /p/<tool>/asset?id=` with a type allowlist (SVG as attachment only), nosniff, a 32 MB default cap and same-origin framing; shell CSP gains `frame-src 'self'`; `host.ui.img`, `host.ui.frame` and `host.ui.link` accept only this plugin's asset ids or panels; conformance checks `asset` answers (#24).
- `host.ui.table`, `host.ui.bars` and `host.ui.spark` (api 1, additive): a sortable text table with an exported `TableColumn` type, horizontal bars with target markers and a small line, built as shell SVG with token colors, text equivalents and bounded input (500 rows, 12 columns, 50 bars, 365 points); `tableColumnProblems` in conformance (#23).
- `acon serve` (H1): resident console with `--host`, `--port` and `--origin`, authenticated by Cloudflare Access JWT (RS256 against the team JWKS) or a bearer token file. It refuses a non-loopback bind without auth, binds confirm tokens to the verified identity, answers 204 on `/healthz` and has no idle exit. A Dockerfile runs it as non-root with a `/data` volume and a health check (#20).
- `acon install <name|https URL|dir>`, `--list` and `--force`: pet and asset packages downloaded separately, verified against the sha256 index at assets.entelecheia.ai (`ACON_ASSETS_INDEX` overrides), https only, streaming size caps, staged and installed with one rename (#17).
- Space Flat/Room/3D views: CSS room camera, opt-in on-demand vendored Three.js, projected keyboard controls, bounded embedded GLB models and Room fallbacks (#14).
- Optional Space area: public plugin scenes, keyed actors/cards and a text roster, fact-driven motion, separately installed image packs and a CSS fallback; pack/pet image validation is shared and asset reads require a session (#13).
- Pet and Mini, moved from agent-hub: Codex v2 pet packages from local folders drawn as CSS sprites whose pose follows the inbox, a compact `#/local/mini` view with one-step answers, and a pop-out through Picture-in-Picture or a popup; `GET /pets/<id>/sheet` behind the session (#12).
- Repeatable UI checks across phone, tablet and desktop widths, both themes and 200% text; rem type tokens, discoverable scrolling tabs and inline status chips on phones (#7).
- `host.ui` panel kit with text-only elements, forms, keyboard-navigable rows and a shared detail template; documented public CSS classes and tokens (#5).
- `acon ui` (H0): loopback console with a one-time link, session cookie, strict CSP and idle exit after 5 minutes.
- Plugin discovery from `$AGENTHUB_HOME/console/plugins/<tool>.json` with module hash and permission checks; `acon plugins` lists the result.
- Console plugin contract api 1 (`@staix/agent-console/contract`) with inbox, search, structured previews and undo, plus a conformance suite (`@staix/agent-console/conformance`).
- Verb reasons (`reason: "optional" | "required"`) asked inline and sent as `reason`; plugin palette commands (`manifest.commands`) that run through `action()`; a conformance check that inbox `at` stays stable; `onSnapshot` skips unchanged polls (#6).
- Confirm tokens for destructive actions: single use, 60 s, bound to session, tool and input.
- Shell: unified inbox with keyboard triage, peek sheet, command palette, confirm dialog, undo toast, System area, light and dark themes, tablet and phone layouts.
