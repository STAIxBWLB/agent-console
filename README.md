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

### Pet and Mini

The pet is an optional character in the top bar that shows what the inbox needs from you. acon ships no character art. It reads Codex v2 pet packages (`pet.json` plus an 8x11 `spritesheet.webp` or `.png` of 192x208 cells, the format the Codex `hatch-pet` skill makes) from these folders, in this order; the first package with an id wins:

1. `$AGENTHUB_HOME/console/pets/<id>/`
2. `$CODEX_HOME/pets/<id>/`
3. `~/.codex/pets/<id>/`

A package is skipped, and listed under System > Errors, when its id is not `[a-z0-9][a-z0-9-]{0,31}`, `spriteVersionNumber` is not 2, the sheet name has a path in it, the sheet is a link, larger than 8 MB or not a WebP or PNG.

The pose follows the inbox only, never a timer:

| Pose (sheet row) | When |
| --- | --- |
| waiting (6) | a decision is waiting |
| failed (5) | an alert is visible, or a tool's inbox could not refresh |
| review (8) | a review or candidate is waiting |
| idle (0) | nothing; a still frame |

Clicking the pet opens the oldest item that needs you. System > Appearance picks the pet or turns it off, per browser.

Mini (`#/local/mini`) is the compact view: the pet, the count and the five oldest items that need you. An item's primary answer runs in place when it is one step (not destructive and no reason); anything else uses Open, which shows the item in the console. The pop-out button (top bar, or Pop out in Mini) opens Mini in an always-on-top Picture-in-Picture window in Chromium browsers, and in a small popup window elsewhere. The console keeps polling while the Picture-in-Picture window is open, even when its tab is hidden.

### Space

Space is an optional area in the rail, shown when a ready plugin declares `capabilities.space: true`. It is never the landing view. The shell polls `snapshot({panel: "space", after})` at the tool's panel interval and combines public scenes under `tool:id` keys.

The area uses `#/local/space`; if a plugin already owns the tool id `space`, the area's link uses `#/local/~space` so that plugin's existing URLs keep working.

The exported `SpaceScene` contract contains:

- `actors`: `id`, `name`, `state` (`idle`, `working`, `waiting`, `blocked`, `away`), optional `pet`, `card` and `marks`, plus a panel `link`.
- `marks`: `kind` (`approval`, `inbox`, `paused`, `mode`) and public `text`.
- `zones`: `id`, `title`, optional `kind` (`queue`, `work`, `review`, `done`) and a non-negative `count`.
- `cards`: `id`, public `title`, `zone`, optional `owner` and `tone`, plus a panel `link`.
- Optional `links`: `kind` (`message`, `overlap`, `conflict`, `cohort`), actor ids `from` and `to`, and optional public `label` and ISO `at`.
- Panel links use `{panel, params?}`. Routing parameters must contain public identifiers, never bodies, private paths or task details.

Strings are limited to 200 characters; at most 32 actors, 200 cards and 64 links are rendered across tools. The server copies only allowed fields and reports dropped records; the shell also caps the combined scene. Conformance rejects extra fields, oversized strings and excess records with named problems. All state labels include text and a glyph. Clicking an actor or card navigates to its panel; Space performs no action. A text roster lists the same actors and zone counts and leads on phones, with the visual scene inside its own scroll box.

Office packs live at `$AGENTHUB_HOME/console/assets/<id>/`. A `pack.json` is at most 16 KB and has this form:

```json
{"id":"office","name":"My office","version":1,"tile":[64,32],"images":{"floor":"floor.webp","wall":"wall.webp","desk":"desk.webp","shelf":"shelf.webp","board":"board.webp"}}
```

Pack ids and logical image names match `[a-z0-9][a-z0-9-]{0,31}`. Each image is a leaf `.webp` or `.png` filename, a regular file with matching image magic, at most 4 MB; package, manifest and image symlinks are refused. Bad packs are skipped and reported in System without blocking other packs. Images are served at `GET /assets/<pack>/<logical-name>` with a live session and revalidated, bounded bytes. Validators are exported from `src/assets.ts` for the separate installer. No artwork is bundled: tests use generated colour pixels. With no pack the scene uses CSS tiles and furniture. Actors use their named pet, a stable assignment from installed pets, or a CSS token.

Motion follows reported facts: working actors use pet row 7, waiting row 6, blocked row 5; idle and away stay still. Card moves transition for at most 0.8 s and new message links fade over 10 s. The first snapshot, a gap over 3 s or more than six changed records settles without transition or replay. Unchanged snapshots write nothing to the scene DOM. Reduced motion removes animation, and stale tool data is labelled and drawn still. There is no scene frame loop. Providers must supply public titles and identifiers; Space never reads message bodies or invents task attribution.

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
- Space: declare `capabilities.space` and answer `{scene: SpaceScene}`. `registerConsoleConformance()` checks the public fields and bounds. The demo plugin includes a three-actor, four-zone fixture; production feeds are supplied by their plugins.

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
- Type sizes: `--acon-text-2xs` (11), `--acon-text-xs` (12), `--acon-text-sm` (13), `--acon-text-md` (14), `--acon-text-base` (15), `--acon-text-lg` (16), `--acon-text-xl` (17), `--acon-text-2xl` (22). Values are rem, with the listed pixel equivalents at the default 16 px browser font size; spacing stays in px.

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

Before UI PRs, run `node scripts/ui-check.mjs`. It finds an existing Playwright install at run time, starts isolated fixture servers and writes screenshots plus `ui-check/report.json`. It checks 375/768/1024/1440 px, both themes and 100%/200% text, including Space with two tools, an explicit synthetic pet/pack and a no-pack fallback. It checks namespace keys, roster parity, navigation and unchanged-poll DOM writes. It exits non-zero on browser errors, text clipping (including the search label), overlap or horizontal overflow. It also checks that the skip link is completely offscreen until focused, reachable by keyboard and moves focus to main when activated. Playwright is a development tool supplied by the person running the check, not a package dependency or CI gate.

Use `PLAYWRIGHT_MODULE` for an absolute Playwright or playwright-core module path, `PLAYWRIGHT_EXECUTABLE_PATH` for an existing Chromium executable, and `BUN_BIN` for Bun when it is not on PATH. `--output <dir>` changes the artifact directory; `--baseline <report.json>` compares 100% text metrics against an earlier run (1 px tolerance). `--force-overflow` is a negative control and must exit non-zero. Use the workspace's remote runner when local browser workloads are deferred.

`--space-motion-only` runs the focused Space motion regression context. It changes public fixture facts through intercepted snapshot responses, checks actual CSS transitions and message consumption, and holds responses until the real snapshot gap exceeds 3 seconds. The normal full run includes this check as well as the viewport matrix.

Record a real macOS Safari/VoiceOver pass in the PR for inbox, peek, palette and confirm: focused element, announced role/name/state, keyboard result and any finding. DOM checks do not substitute for VoiceOver announcements; the owner decides whether a VoiceOver finding blocks merge.

License: MIT
