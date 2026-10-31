# agent-console

`acon` is a local web console for the agent tool family: agent-hub (agents and tasks), agent-mem (memory) and vault-mem (knowledge vault). Each tool contributes panels as a plugin. The console adds what no single tool has: one inbox of everything waiting for you, a command palette across tools, and one confirm dialog for every destructive action.

Status: H0 (local mode) only. No tool ships its plugin yet; a fixture plugin in `test/fixtures/` shows the contract. Authenticated nodes (H1) and the static multi-node shell (H2) are not implemented.

## Use

Requires Bun 1.4.2 or later. The package is not published yet; run it from a checkout:

```sh
bun install
bun bin/acon.js ui            # opens the browser with a one-time link
bun bin/acon.js ui --no-open --json
bun bin/acon.js plugins       # registered plugins and their hash check
```

The server listens on 127.0.0.1 only and exits 5 minutes after the last request. The link works once and expires after 60 seconds.

Keys: `Cmd/Ctrl K` palette, `j`/`k` move, `Space` peek, `Enter` open, `1` primary answer, `2` second answer, `h` snooze for an hour, `?` all keys.

## Writing a plugin

A tool registers by writing `$AGENTHUB_HOME/console/plugins/<tool>.json` (default home `~/.agenthub`; directory mode 0700):

```json
{ "api": 1, "tool": "vmem", "module": "/abs/path/to/src/ui/plugin.ts", "sha256": "<sha256 of that file>" }
```

The module's default export is a `ConsolePlugin` (`@staix/agent-console/contract`): a manifest with panels and capabilities, and `open()` returning a provider with `assets.js` (an ES module), optional `assets.css`, `snapshot()` and `action()`. The console refuses a module whose hash changed until the tool's setup runs again.

- Inbox: declare `capabilities.inbox` and answer `snapshot({panel: "inbox"})` with `{items: InboxItem[]}`. Verbs run through `action({action: verb.id, id})`.
- Search: declare `capabilities.search` and answer `snapshot({panel: "search", q, limit})` with `{hits, total}`.
- Destructive actions answer `{ok: false, needsConfirm: true, preview, fingerprint, changes?, warnings?, verb?, confirmText?}`. The console shows its dialog and calls again with `confirmed: true` and the fingerprint; recompute it and refuse on drift.
- Reversible actions may return `undo: {action, ...}`; the console offers it for 10 seconds.
- Panels run under a strict CSP: no inline scripts or `style=` attributes, nothing from other origins. Style with the `--acon-*` tokens.

Check a plugin with the conformance suite:

```ts
import { registerConsoleConformance } from "@staix/agent-console/conformance";
registerConsoleConformance(plugin, { destructive: [{ action: "delete", id: "x" }] });
```

## Develop

```sh
bun install --frozen-lockfile
bun run check   # typecheck, boundary, tests, pack dry-run
```

License: MIT
