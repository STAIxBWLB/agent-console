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

- Inbox: declare `capabilities.inbox` and answer `snapshot({panel: "inbox"})` with `{items: InboxItem[]}`. Verbs run through `action({action: verb.id, id})`. Keep each item's `at` the same across snapshots: snooze and oldest-first order key on it, and conformance checks it.
- Reasons: a verb with `reason: "optional"` or `"required"` makes the console ask for a reason inline and send it as `reason` in the action input; a required reason cannot be sent empty.
- Commands: `manifest.commands` (`{id, title, hint?, action, input?}[]`) appear in the palette under the tool and run `action({...input, action})`, so a destructive command gets the same confirm dialog. `input` may not set `action`, `confirmed`, `fingerprint` or `confirmToken`, and with `capabilities.actions` declared the action must be listed there.
- Panels: `onSnapshot` fires on each `show()` and then only when the snapshot data changed, so a panel need not diff unchanged polls.
- Search: declare `capabilities.search` and answer `snapshot({panel: "search", q, limit})` with `{hits, total}`.
- Destructive actions answer `{ok: false, needsConfirm: true, preview, fingerprint, changes?, warnings?, verb?, confirmText?}`. The console shows its dialog and calls again with `confirmed: true` and the fingerprint; recompute it and refuse on drift.
- Reversible actions may return `undo: {action, ...}`; the console offers it for 10 seconds.
- Panels run under a strict CSP: no inline scripts or `style=` attributes, nothing from other origins. Style with the `--acon-*` tokens.

### Panel kit

Each panel receives `host.ui`, typed as `ConsoleUi` from `@staix/agent-console/contract`. The kit returns DOM nodes and renders strings as text, including strings containing HTML. Use it through the host; panels do not import shell files.

| Method | Result |
|---|---|
| `h(tag, props?, ...kids)` | An element with text or node children; `text` sets text and function-valued `on*` props attach event listeners. |
| `rows(items, render)` | A list of rendered rows, or `null` when the array is empty. |
| `row({title, sub?, onOpen?, chip?, verbs?})` | A row with an open control, optional subtitle, state chip and action nodes. |
| `empty(title, hint?)` | An empty state with an optional hint. |
| `chip(text, tone?)` | A compact state label. |
| `notice(text, tone?)` | A status notice. |
| `form(fields, submit, onSubmit)` | A labeled form; fields are `{name, label, required?, value?}`, submit is `{label, primary?}`, and the callback receives string values by field name. |
| `detail(options)` | The shared detail template: kind/title/state header, whose move, actions, summary, provenance, collapsible sections and mono footer. |

`h` accepts these tags: `div`, `span`, `p`, `strong`, `em`, `small`, `code`, `pre`, `section`, `article`, `header`, `footer`, `h1`, `h2`, `h3`, `h4`, `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `button`, `input`, `textarea`, `select`, `option`, `form`, `label`, `fieldset`, `legend`, `details`, `summary`, `time`, `hr`, `br`.

Its attributes are `class`, `text`, `id`, `title`, `role`, `tabindex`, `type`, `name`, `value`, `placeholder`, `required`, `disabled`, `readonly`, `checked`, `multiple`, `autocomplete`, `maxlength`, `min`, `max`, `step`, `for`, `open`, `datetime`, plus `aria-*` and `data-*`. Event props such as `onclick` accept functions only. Unsupported tags or attributes throw `TypeError`; URL attributes, `style` and string event handlers are unsupported.

`Tone` is `"ok" | "warn" | "err" | "neutral"`. `detail` accepts `kind` and `title`, optional `state: {text, tone?}`, `whoseMove: "you" | "agent"`, `actions`, `summary`, `provenance: {label, value, at?}[]`, `sections: {title, body, open?}[]` and `footer: string[]`. Sections start collapsed unless `open` is true; section strings are text, while node bodies can contain other kit elements.

```js
export default (host) => {
  const { ui } = host;
  host.onSnapshot((snapshot) => {
    const rows = ui.rows(snapshot.notes ?? [], (note) => ui.row({
      title: note.title,
      sub: note.status,
      onOpen: () => host.navigate(host.tool, "notes", { id: note.id }),
      verbs: [ui.h("button", {
        type: "button", class: "btn danger", text: "Delete...",
        onclick: () => host.action({ action: "delete", id: note.id }),
      })],
    }));
    host.mount.replaceChildren(rows ?? ui.empty("No notes", "New notes will appear here."));
  });
  return { show() {}, hide() {}, destroy() { host.mount.replaceChildren(); } };
};
```

With focus on kit rows inside a panel, `j` and `k` move between rows and `Enter` opens the focused row. Form input keeps its normal typing behavior. Run actions through `host.action()` so destructive actions keep the shell's confirmation flow.

### Public styling contract

Panels may use these classes. Modifiers apply only with their base class:

- Lists and rows: `rows`, `row`, `row-main`, `row-text`, `row-title`, `row-sub`, `row-verbs`, `ui-rows`, `ui-row-open`.
- Controls and status: `btn` with `primary` or `danger`; `chip` with `ok`, `warn`, `err` or `accent`; `notice`; `ui-notice` with `ok`, `warn` or `err`.
- Containers and text: `empty`, `card`, `mono`, `ui-form`, `ui-field`.
- Details: `ui-detail`, `ui-detail-head`, `ui-detail-kind`, `ui-detail-move`, `ui-detail-actions`, `ui-detail-summary`, `ui-provenance`, `ui-detail-section`, `ui-detail-body`, `ui-detail-footer`.

The public CSS tokens are:

- Surfaces and text: `--acon-bg`, `--acon-surface`, `--acon-surface-2`, `--acon-line`, `--acon-line-2`, `--acon-text`, `--acon-text-2`.
- Accent and status: `--acon-accent`, `--acon-accent-soft`, `--acon-accent-text`, `--acon-on-accent`, `--acon-ok`, `--acon-ok-soft`, `--acon-warn`, `--acon-warn-soft`, `--acon-err`, `--acon-err-soft`, `--acon-focus`.
- Spacing: `--acon-space-1`, `--acon-space-2`, `--acon-space-3`, `--acon-space-4`, `--acon-space-5`, `--acon-space-6`.
- Shape and motion: `--acon-radius-1`, `--acon-radius-2`, `--acon-radius-3`, `--acon-shadow`, `--acon-ease`.
- Fonts: `--acon-font-ui`, `--acon-font-mono`.

Use the tokens in a plugin's own CSS for light and dark themes. `host.theme.tokens` exposes the color tokens; other tokens are available as CSS custom properties. Shell selectors outside the documented public classes are private and may change.

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
