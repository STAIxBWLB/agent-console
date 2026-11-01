# Changelog

## [Unreleased]

### Fixed

- Plugin discovery scans files that start with a `#!` line (CLI entry files) instead of marking the plugin "cannot be read"; a file that cannot be scanned is now named in the reason. The stripped line ends at any JavaScript line terminator (LF, CR, U+2028, U+2029), so an import after a CR-terminated `#!` is still checked.

### Added

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
