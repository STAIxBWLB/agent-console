# agent-console

`acon` is a local web console for the agent tool family: agent-hub (agents and tasks), agent-mem (memory), vault-mem (knowledge vault) and agent-research (research). Each tool contributes panels as a plugin. The console adds what no single tool has: one inbox of everything waiting for you, a command palette across tools, and one confirm dialog for every destructive action.

Status: H0 (`acon ui`, local mode) and H1 (`acon serve`, an authenticated resident node). agent-hub, agent-mem, vault-mem and agent-research register their plugins (table below); a fixture plugin in `test/fixtures/` shows the contract. H2 (`acon build --static`) serves a credential-free shell over independently authenticated H1 nodes.

<!-- facts:package -->
- Package `@staix/agent-console` 0.1.6, command `acon`. Install: `bun add -g @staix/agent-console`.
- Requires Bun >=1.4.2 (`engines.bun`).
- Library exports: `@staix/agent-console` (`src/contract.ts`), `@staix/agent-console/contract` (`src/contract.ts`), `@staix/agent-console/conformance` (`src/conformance.ts`), `@staix/agent-console/visual-cases` (`src/visual-cases.ts`).
- Plugin contract api: 1.
<!-- /facts:package -->

The known producers, the contract api their registrations declare and the agent-console version each one pins (checked by hand in each repository; see `scripts/readme-facts.ts`):

<!-- facts:producers -->
| Tool | Repository | Registers with | Contract api | Pins agent-console |
| --- | --- | --- | --- | --- |
| `ahub` | [agent-hub](https://github.com/STAIxBWLB/agent-hub) | `ahub setup` | 1 | 0.1.3 |
| `amem` | [agent-mem](https://github.com/STAIxBWLB/agent-mem) | `amem setup console --apply` | 1 | 0.1.3 |
| `vmem` | [vault-mem](https://github.com/STAIxBWLB/vault-mem) | `vmem setup <host> --apply` | 1 | commit 4c4c1e0 (after 0.1.0, before 0.1.1) |
| `ares` | [agent-research](https://github.com/STAIxBWLB/agent-research) | `ares setup console --apply` | 1 | commit 27e4f89 (0.1.2) |
<!-- /facts:producers -->

## Use

Install the published package, or run `bun install` and `bun bin/acon.js` from a checkout:

```sh
bun add -g @staix/agent-console
acon ui                       # opens the browser with a one-time link
acon ui --no-open --json
acon plugins                  # registered plugins and their hash check
```

All commands, as `acon help` prints them:

<!-- facts:commands -->
```text
acon ui [--no-open] [--json]   serve the console on 127.0.0.1 and print a one-time link
acon serve [--host H] [--port P] [--origin https://host]... [--read-only] [--json]
                               resident console behind Cloudflare Access or a bearer token
acon build --static --nodes id=https://origin[,id=origin] [--out dist]
                               write the static multi-node shell (no credentials or plugin data)
acon token new [--file PATH] [--force]
                               write a 0600 bearer token file (default $AGENTHUB_HOME/console/token); prints the path only
acon setup launchd [--label ID] [--apply] [serve flags]
                               print a LaunchAgent plist for acon serve; --apply installs and loads it
acon plugins [--json]          list registered plugins and verify their module hashes
acon install <name|https URL|dir> [--force]
                               install a pet or asset package
acon install --list [--json]   list the packages in the index
acon --version | help
```
<!-- /facts:commands -->

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

The view control offers **Flat**, **Room** and, when WebGL2 is available, **3D**. The browser saves the choice as `acon.space.view`. Flat keeps the normal layout. Room uses CSS 3D floor and wall planes with upright actor/card buttons, without downloading Three.js. Rotate left/right changes yaw by 90 degrees; zoom has three steps. Focus the scene and use Left/Right or +/- for the same controls. Reduced motion removes camera transitions.

3D is opt-in and loads the vendored renderer only when selected. The default camera frames the scene's content, turning its long axis down the screen on a portrait canvas; pack models are fitted by width with a height cap so desks, boards and shelves read as furniture. Room frames every billboard inside its scroll box. Drag empty canvas space to orbit, or use the same camera controls. Actor and work-item buttons remain in the same keyboard order and follow their projected screen positions; focus or hover reveals their labels. The text roster remains available and leads on phones. Missing WebGL2, renderer startup failure or context loss returns to Room with a notice. Canvas draws happen on changed public facts, asset completion and camera input, with a sprite burst bounded to 0.8 seconds; settled scenes schedule no frame or animation timer. Reduced motion draws the final pose immediately.

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

Pack ids and logical image names match `[a-z0-9][a-z0-9-]{0,31}`. Each image is a leaf `.webp` or `.png` filename, a regular file with matching image magic, at most 4 MB; package, manifest and image symlinks are refused. Bad packs are skipped and reported in System without blocking other packs. Images are served at `GET /assets/<pack>/<logical-name>` with a live session and revalidated, bounded bytes. An optional `models` object maps the same logical furniture names to leaf `.glb` filenames, for example `"models": {"desk":"desk.glb","shelf":"shelf.glb","board":"board.glb"}`. Each model is a regular, non-symlink file capped at 4 MB, with a GLB 2 `glTF` header, valid chunk lengths and embedded buffers/images only; resource URLs are refused. The authenticated `GET /models/<pack>/<logical-name>` revalidates the bytes on every response. 3D loads models when present and uses boxes when absent or unavailable; Room uses images or CSS furniture. Validators are exported from `src/assets.ts` for the separate installer. No artwork is bundled: tests use generated colour pixels. With no pack the scene uses CSS tiles and furniture. Actors use their named pet, a stable assignment from installed pets, or a CSS token.

Motion follows reported facts: working actors use pet row 7, waiting row 6, blocked row 5; idle and away stay still. Card moves transition for at most 0.8 s and new message links fade over 10 s. The first snapshot, a gap over 3 s or more than six changed records settles without transition or replay. Unchanged snapshots write nothing to the scene DOM. Reduced motion removes animation, and stale tool data is labelled and drawn still. Flat and Room have no JavaScript scene frame loop; optional 3D draws only on demand. Providers must supply public titles and identifiers; Space never reads message bodies or invents task attribution.

### Install packages

acon ships no art. Pets and office packs are installed separately:

```sh
acon install --list                 # what the index offers
acon install gyul                   # a package from the index; every file's sha256 is checked
acon install https://host/x/pet.json  # any https host (pet.json or pack.json); not hash-verified
acon install ./my-pet               # a local folder (written as a path; a bare name always means the index) with a pet.json or pack.json; not hash-verified
acon install gyul --force           # replace an installed package with the same id
```

Pets go to `$AGENTHUB_HOME/console/pets/<id>/` and packs to `$AGENTHUB_HOME/console/assets/<id>/` (folders 0700, files 0600). To remove a package, delete its folder. The console scans these folders at start, so run `acon ui` again to see a new package.

The index is `https://assets.entelecheia.ai/console/index.json`; `ACON_ASSETS_INDEX` overrides it. Its form:

```json
{ "version": 1,
  "packages": [
    { "kind": "pet", "id": "gyul", "name": "Gyul", "description": "...", "manifest": "../pets/gyul/pet.json",
      "size": 210494, "files": { "pet.json": "<sha256>", "spritesheet.webp": "<sha256>" } },
    { "kind": "pack", "id": "office", "name": "Office", "manifest": "packs/office/pack.json",
      "size": 3967552, "files": { "pack.json": "<sha256>", "floor.webp": "<sha256>", "desk.glb": "<sha256>" } }
  ] }
```

`manifest` resolves against the index URL and every file is a plain name in the manifest's folder. A pack may list `models` (logical name to `.glb` file) next to `images`.

Rules:

- Only `https:`; `http:` only on loopback hosts. Redirects are followed only to `https:`.
- Each file has a 30 s timeout and a cap enforced while streaming: manifest 16 KB, pet sheet 8 MB, pack image 4 MB, model 4 MB (glTF binary magic), 32 MB per package.
- Files are written to a staging folder under `$AGENTHUB_HOME/console/.install/`, checked with the same validation the console runs at start, then moved into place with one rename. A failure leaves nothing behind. An installed id is refused before any download unless `--force` is given, and `--force` replaces the old folder only after the new one is complete.
- Nothing is executed.

## Run as a server

`acon serve` (H1) is the resident form of the console for a node behind a reverse tunnel or on an internal server. `acon ui` is unchanged.

```sh
acon serve [--host 127.0.0.1] [--port 8787] [--origin https://console.example.com]... [--read-only] [--json]
```

- No ticket link, no idle exit and no browser opening. The process stays up until it is stopped. `--port` defaults to `ACON_PORT`, or 8787 when that is unset.
- `--origin` (repeatable, or comma-separated in `ACON_ORIGINS`) lists the exact browser origins. They are `https:`, or `http:` only on loopback or a WARP device address in `100.64.0.0/10`. POST needs one of them as `Origin`. `Host` must be one of their hosts or the bind address, which local health checks use.
- `GET /healthz` answers 204 with no body and no authentication. Every other route, the shell files included, needs authentication.
- Authentication is required unless `--host` is a loopback address. Starting on another address without it is refused. There are two modes:
  - Cloudflare Access: set `ACON_ACCESS_TEAM` (the team domain, `<team>.cloudflareaccess.com`) and `ACON_ACCESS_AUD` (the Access application's AUD tag). Each request's `Cf-Access-Jwt-Assertion` must verify as RS256 against `https://<team>/cdn-cgi/access/certs`. The keys are cached and refetched on an unknown `kid`. The checks are `aud` contains the AUD, `iss` is `https://<team>`, `exp`/`nbf` hold with 60 s skew, and `sub` (or `email`) is present.
  - Bearer token: set `ACON_TOKEN_FILE` to a file with mode 0600 holding one random token of at least 32 characters. `acon token new [--file PATH] [--force]` writes one (32 random bytes, base64url) to `$AGENTHUB_HOME/console/token` by default. It creates the file exclusively with mode 0600, refuses an existing file unless `--force` is given, and prints only the path, never the token. Requests send `Authorization: Bearer <token>`. The comparison is constant-time. A file readable by group or others is refused.
  - Browser sign-in (bearer mode only): a browser opening `/` unauthenticated is redirected to `/login`, a script-free form that takes the token and sets an `HttpOnly; SameSite=Strict` session cookie for 12 hours that stands for the token. The POST needs a configured `Origin`. Access and loopback nodes have no `/login`.
- The verified identity (the Access `sub`, or `bearer`) takes the place of the ticket session. Confirm tokens for destructive actions are bound to it, so a preview confirmed by another identity is refused. The page skips the ticket step because `/session` answers `{ok: true, mode: "serve"}`.
- CSP, headers, plugins, the confirm path and the 32 KB body limit are the same as under `acon ui`.
- Read-only node: `--read-only` or `ACON_READ_ONLY=1`. Every `/p/<tool>/action` answers 403 `{ok: false, error: "read-only node"}` before any confirm-token lookup, without calling the plugin and without issuing a confirm token. `/tools` reports `readOnly: true`, and the shell shows a "Read-only" chip and disables verb, answer and confirm buttons. Snapshots, search and assets are unchanged. Authentication rules do not change.

### Local Mac and other Macs over WARP

The console runs on your own Mac. Your other Macs reach it over the Cloudflare WARP device mesh when the WARP profile sends WARP device addresses (`100.96.0.0/12`) through WARP. Find this Mac's address with `ifconfig | grep 'inet 100\.'`.

Run two agents: one on loopback for this Mac, with no token, and one with a token for the other Macs.

```sh
acon token new
acon setup launchd --label acon.local --port 8790 --apply
ACON_TOKEN_FILE=~/.agenthub/console/token \
  acon setup launchd --label acon.warp --host 0.0.0.0 --port 8791 --origin http://100.96.0.68:8791 --apply
```

On this Mac open `http://127.0.0.1:8790`. On another Mac with WARP connected, open `http://100.96.0.68:8791` and paste the token (`pbcopy < ~/.agenthub/console/token` on this Mac). WARP encrypts that traffic. `0.0.0.0` also listens on the LAN, where every request still needs the token, but sign in only through the WARP address, because the LAN carries plain http.

### LaunchAgent (macOS)

```sh
acon setup launchd [--label acon.serve] [--apply] [--host H] [--port P] [--origin https://host]... [--read-only]
```

Prints a LaunchAgent plist that runs the absolute `bun` (the PATH entry, such as Homebrew's `bin/bun` link, when it is the running binary, so an upgrade does not remove it) and this checkout's `bin/acon.js serve` with the given flags, with `RunAtLoad`, `KeepAlive` and logs in `$AGENTHUB_HOME/console/logs/<label>.{out,err}.log`. It applies the same refusals as `acon serve` first. Auth is copied as environment names that point to files or settings (`ACON_TOKEN_FILE` as an absolute path, `ACON_ACCESS_TEAM`, `ACON_ACCESS_AUD`, `ACON_ORIGINS`, `ACON_PORT`, `ACON_READ_ONLY`), never a token value. Without `--apply` nothing is written. `--apply` writes `~/Library/LaunchAgents/<label>.plist`, runs `launchctl bootout`, waits up to 10 s until the old agent is gone, then runs `bootstrap` in `gui/<uid>`, and prints `launchctl print`. A tunnel agent is not part of this.

### Versioned install

From a checkout, `bun scripts/install-release.ts [--home DIR] [--json]` copies the committed package files (not uncommitted changes) into `$AGENTHUB_HOME/console/releases/<version>-<commit>/`, then points `console/current` at it by atomic rename and keeps `console/previous`. An existing release is reused, never changed. Start the resident console from `console/current/bin/acon.js`: an install leaves a running process on the release it started from, and a restart switches it. Roll back by pointing `current` at `previous` and restarting.

### Static multi-node shell (H2)

Build into a new output directory (an existing destination is refused):

```sh
acon build --static --nodes desk=https://desk.example.com,dgx=https://dgx.example.com --out dist
```

Each URL must be an exact HTTPS origin, without credentials, paths, queries or fragments. HTTP is allowed only for loopback development. Configure each H1 node with both its public origin and the shell origin, for example `acon serve --origin https://desk.example.com --origin https://console.example.com`, and its own bearer token file or Cloudflare Access application. The node origin also registers its public Host value; the shell origin permits CORS. Keep authentication enabled off loopback.

Build one static shell only over equally trusted nodes (such as your own nodes). Each node's panel modules execute with the shell's authority; a compromised node or plugin can use every node's credentials in that tab while it is open. Use separate builds for nodes with different trust.

The output contains fixed shell/vendor files, public `config.json`, `_headers`, `vercel.json`, an assets-only `wrangler.jsonc`, `.assetsignore` and `.vercelignore` (each host skips the other's configuration). It contains no plugin data or credentials. Upload the complete directory to a preview with the supplied header configuration. The first `vercel deploy` of a new project can become a production deployment on a public alias even with `--target preview`: link the project first (`vercel link`), then check that `vercel inspect` shows `target preview` before sharing a URL. On Workers, `wrangler versions upload` needs an existing Worker, so the first `wrangler deploy` is a production deployment on workers.dev and needs the same authorization as any production shell. Main-document CSP permits connections, scripts and images only from self and the configured node origins; plugin styles are fetched with node auth into constructed stylesheets, and attachments use a local sandboxed viewer. The sandboxed visual/attachment documents have separate header policies.

In System, each node has its own bearer-token form and Access sign-in/reconnect controls. Bearer tokens stay in that tab's `sessionStorage`; Access uses that node's cookies with credentialed requests. Access CORS/cookie policy must also permit the shell origin. Authenticated nodes issue short-lived GET-only resource grants for panel modules and attachments because native module/image requests cannot carry bearer headers. These runtime grants are node-specific, contain no bearer token and never authorize actions. Keep node access logs private, since runtime resource URLs contain these grants. The "Open attachment" link also includes a GET-only grant and can leave it in browser history for its remaining lifetime (at most 1 hour); keep that history private too.

Tools are namespaced `node:tool`; panel `host.node` identifies the owner and `host.tool` keeps its original tool id. All actions, confirmations and read-only restrictions stay on that owner. System distinguishes online, offline, unauthorized and `refused (origin)` nodes. A bounded opaque health probe distinguishes an unreachable node from a reachable node blocked by CORS; persistent failures refresh at most once per tool-list interval, without repeated prompts. Use System to reconnect after fixing a URL, token or `--origin`.

A one-node Vercel preview read back the built CSP, frame and nosniff headers on every policy path, and `wrangler dev` applied the same `_headers`; a hosted Workers version is unverified. No production deployment or Access application configuration is performed by the build command.

### Docker

When the repository variable `IMAGE_PUBLISH_ENABLED` is `true`, a tagged release (after npm publish) pushes `ghcr.io/staixbwlb/agent-console:<version>`, plus `latest` for stable versions, for `linux/amd64` and `linux/arm64`, with OCI `source`, `revision` and `version` labels. The release job reads the manifest back for both architectures, checks the revision label and runs `--version` on amd64.

The `Dockerfile` builds a pinned `oven/bun` image that runs `acon serve --host 0.0.0.0` as the non-root `bun` user. `AGENTHUB_HOME=/data` is a volume holding plugins, pets and asset packs, and a `HEALTHCHECK` probes `/healthz`. The image holds no credentials:

```sh
docker build -t acon .
docker run -d --name acon -p 127.0.0.1:8787:8787 -v acon-data:/data \
  -e ACON_ORIGINS=https://console.example.com \
  -e ACON_ACCESS_TEAM=<team>.cloudflareaccess.com -e ACON_ACCESS_AUD=<aud-tag> acon
```

For bearer mode, mount the token file read-only instead (for example `-v /path/token:/run/acon-token:ro -e ACON_TOKEN_FILE=/run/acon-token`). The file must be owned by the container user with mode 0600. Install packages into the volume with `docker exec acon bun bin/acon.js install <name>`, then restart the container.

The app files are world-readable whatever the build checkout's umask, so `--user <uid>:<gid>` works too. Use it with a host directory owned by that uid as `/data` (`-v /srv/acon:/data`), and no chown is needed. To change the port, set `ACON_PORT` rather than passing `--port`: serve and the `HEALTHCHECK` both read it.

### Cloudflare Tunnel and Access (outline)

1. Run the container with its port published on loopback only, as above.
2. Create a Cloudflare Tunnel on the same host whose public hostname points at `http://127.0.0.1:8787`.
3. Create an Access self-hosted application for that hostname with a policy for the people who may use it. Copy its AUD tag.
4. Start the container with `ACON_ORIGINS=https://<public hostname>`, `ACON_ACCESS_TEAM=<team>.cloudflareaccess.com` and `ACON_ACCESS_AUD=<aud-tag>`.

Keep the hostname, team and AUD in your deployment's private configuration, not in this repository.

## Writing a plugin

A tool registers by writing `$AGENTHUB_HOME/console/plugins/<tool>.json` (default home `~/.agenthub`; directory mode 0700):

```json
{ "api": 1, "tool": "vmem", "module": "/abs/path/to/src/ui/plugin.ts", "sha256": "<sha256 of that file>" }
```

The module's default export is a `ConsolePlugin` (`@staix/agent-console/contract`): a manifest with panels and capabilities, and `open()` returning a provider with `assets.js` (an ES module), optional `assets.css`, `snapshot()` and `action()`. The console refuses a module whose hash changed until the tool's setup runs again. The hash covers the entry file only; files it imports are not hashed, but the import scan refuses an import outside the plugin's package.

Versions and upgrades (#26):
- API range: `"apiMin"` and `"apiMax"` (in the registration file and in the manifest) declare the console apis a plugin works with; `"api"` alone means that one api. This console speaks api 1. A plugin whose range does not overlap is listed as invalid with the ranges named.
- Versioned registrations: a tool may write `plugins/<tool>@<version>.json` (semantic version) beside `plugins/<tool>.json`. Per tool the newest one that verifies and loads is used; if it fails to load, the next one is tried; the others are listed as `superseded`.
- No restart needed for a new path: the console re-scans the directory at most every 5 s while a page is open. A module at a path not loaded before (a versioned install such as `releases/<version>/`) serves pages opened after it; an open page keeps the load it started with (System says when a newer one is registered), and every load stays in memory until the console restarts. A module from a package the console already imported from (changed in place, or a file first loaded as a dependency) is not hot-loaded, because the runtime keeps one module per path: the current load keeps serving and System says to restart. If a registration turns stale or disappears, the current load keeps serving and System records the problem once.

- Inbox: declare `capabilities.inbox` and answer `snapshot({panel: "inbox"})` with `{items: InboxItem[]}`. Verbs run through `action({action: verb.id, id})`. Keep each item's `at` the same across snapshots: snooze and oldest-first order key on it, and conformance checks it.
- Reasons: a verb with `reason: "optional"` or `"required"` makes the console ask for a reason inline and send it as `reason` in the action input; a required reason cannot be sent empty.
- Features (#27): `open(ctx)` receives `ctx.features` from this console: `"inbox.form"`, `"inbox.result"` and `"action.meta"`. Send forms and result items only when the matching feature is present; an older console has no `features` and reports both as malformed.
- Choice questions: a verb may carry `form: {questions}` (1-4 questions, 2-8 options each, optional `multiple` and `other: {label?, maxLength?}`; bounds in `VerbForm` and `verbFormProblems` from the conformance module). The peek shows the questions, then a review step when there are several, and sends `action({action: verb.id, id, answers})` with `answers: {[questionId]: {selected: string[], other?: string}}`. The console stores no answer: the tool accepts or refuses it, and on `{ok: false, error}` the console shows the error, refreshes and keeps the person's draft. Keys: `1` focuses the form (or submits from its button), `2` runs the second verb, `h` snoozes; inside the form arrows move, Space toggles and Enter goes on.
- Results: items in the `result` group are finished work to read, shown after reviews and counted apart ("2 results to read"); they do not count for the tab badge or the pet. With `seen: {action}`, the console sends `action({action, id, seenAt})` once per page session when the item's body end has been in view for 1 s in a visible, focused window (the peek), and `explicit: true` from the group's "Mark all read". A row in the list never counts as seen.
- Who acted: with `"action.meta"`, `action(input, meta)` gets `meta: {identity, node, via: "console"}` built from the verified session (`"local"` under `acon ui`; `"access:<subject>"`, `"bearer"` or `"loopback"` under `acon serve`). The page cannot set it; an input key named `meta` stays page data.
- Commands: `manifest.commands` (`{id, title, hint?, action, input?}[]`) appear in the palette under the tool and run `action({...input, action})`, so a destructive command gets the same confirm dialog. `input` may not set `action`, `confirmed`, `fingerprint` or `confirmToken`, and with `capabilities.actions` declared the action must be listed there.
- Panels: `onSnapshot` fires on each `show()` and then only when the snapshot data changed, so a panel need not diff unchanged polls.
- Search: declare `capabilities.search` and answer `snapshot({panel: "search", q, limit})` with `{hits, total}`.
- Destructive actions answer `{ok: false, needsConfirm: true, preview, fingerprint, changes?, warnings?, verb?, confirmText?}`. The console shows its dialog and calls again with `confirmed: true` and the fingerprint; recompute it and refuse on drift.
- Reversible actions may return `undo: {action, ...}`; the console offers it for 10 seconds.
- Panels run under a strict CSP: no inline scripts or `style=` attributes, nothing from other origins. Style with the `--acon-*` tokens.
- Space: declare `capabilities.space` and answer `{scene: SpaceScene}`. `registerConsoleConformance()` checks the public fields and bounds. The demo plugin includes a three-actor, four-zone fixture; production feeds are supplied by their plugins.

### Panel kit

Each panel receives `host.ui`, typed as `ConsoleUi` from `@staix/agent-console/contract`. The kit returns DOM nodes and renders strings as text, including strings containing HTML. Use it through the host; panels do not import shell files. The contract compiles without the DOM lib: its panel types (`PanelElement`, `PanelButton`, `PanelForm`, `PanelNode`) are the DOM's `HTMLElement`, `HTMLButtonElement`, `HTMLFormElement` and `Node` when the consumer has the DOM lib, and the structural `ConsoleElement` and `ConsoleNode` otherwise.

| Method | Result |
|---|---|
| `h(tag, props?, ...kids)` | An element with text or node children; `text` sets text and function-valued `on*` props attach event listeners. |
| `rows(items, render)` | A list of rendered rows, or `null` when the array is empty. |
| `row({title, sub?, onOpen?, chip?, verbs?})` | A row with an open control, optional subtitle, state chip and action nodes. |
| `empty(title, hint?)` | An empty state with an optional hint. |
| `chip(text, tone?)` | A compact state label. |
| `button(label, onClick, {tone?, disabled?}?)` | A `button.btn` with `type="button"`; `tone` is `"primary"` or `"danger"` and adds that modifier. |
| `notice(text, tone?)` | A status notice. Tone `err` uses `role="alert"` (announced at once); other tones use `role="status"`. |
| `form(fields, submit, onSubmit)` | A labeled form; fields are `{name, label, required?, value?}`, submit is `{label, primary?}`, and the callback receives string values by field name. |
| `detail(options)` | The shared detail template: kind/title/state header, whose move, actions, summary, provenance, collapsible sections and mono footer. |
| `table({columns, rows, caption?, sortable?})` | A table with text cells. A column is a `TableColumn`: `{key, label, align?: "start" \| "end", format?: "text" \| "number" \| "percent"}`. Header buttons sort stably (ascending, then descending) and set `aria-sort`; `sortable: false` turns this off. |
| `bars({items, max?, caption})` | Horizontal SVG bars; items are `{label, value, target?}` and `target` draws a marker. `max` defaults to the largest value or target. |
| `spark({values, caption})` | A small SVG line with a low/high/last summary. |
| `img({asset, alt})` | An image of this plugin's asset (PNG or JPEG). |
| `frame({asset, title})` | A same-origin frame of this plugin's asset, for PDF or text. |
| `link({asset} \| {panel, params?}, text)` | A link to this plugin's asset (opens in a new tab) or to one of its panels. |
| `review({doc, threads, onComment, onPlacement?})` | A line-numbered review of a `text`, `prose` or `diff` document. Select a range (pointer, or a gutter with Shift+Up/Down, then Enter), write a comment and the kit calls `onComment({anchor, body})`; send it to your tool with `host.action()` and throw (or reject) when the result is not `ok`, so the kit keeps the draft and says the comment was not sent. Existing threads show as gutter marks or, when they cannot be placed, in a strip above the view. |
| `visual(payload)` | A `mermaid` diagram in a sandboxed frame, `comparison` cards, a `table` (through `table`) or a `beforeAfter` pair (text, or an asset through `img`). See "Visuals". |

Table and charts are built by the shell from attributes and CSS classes, so they need no CSP change. Each chart has the caption as its accessible name and a text equivalent: bars show each value (and target) as text, and spark carries a visually hidden list of values. Inputs are bounded: 500 rows and 12 columns per table, 50 bar items and the last 365 spark points. Larger input is cut and a `ui-notice` states how much is shown. `tableColumnProblems(columns)` from `@staix/agent-console/conformance` checks a column list.

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
      verbs: [ui.button("Delete...", () => host.action({ action: "delete", id: note.id }), { tone: "danger" })],
    }));
    host.mount.replaceChildren(rows ?? ui.empty("No notes", "New notes will appear here."));
  });
  return { show() {}, hide() {}, destroy() { host.mount.replaceChildren(); } };
};
```

With focus on kit rows inside a panel, `j` and `k` move between rows and `Enter` opens the focused row. Form input keeps its normal typing behavior. Run actions through `host.action()` so destructive actions keep the shell's confirmation flow.

### Plugin assets

A provider may implement `asset({id})` and answer `{bytes: Uint8Array, mime, name}`, or `null` for an unknown id. The console serves it at `GET /p/<tool>/asset?id=<id>` with the same Host, Origin and session checks as other plugin routes (and the `acon serve` authentication), plus `X-Content-Type-Options: nosniff`, a `Content-Disposition` filename and a framing policy of same origin only. A cross-site fetch gets 403, an unknown id 404.

- Types: `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `text/plain` and `text/csv` are served inline; `image/svg+xml` is served only as an attachment. Any other type gets 415. Declared `image/webp` must have RIFF/WEBP magic bytes regardless of the filename; a mismatch gets 502 as an invalid plugin answer.
- Size: 32 MB per asset by default (`ServerOptions.assetMaxBytes`); larger answers get 413.
- Panels reference assets only through `ui.img`, `ui.frame` and `ui.link`, which build the URL from the panel's own tool and an id. URLs, other tools and other link targets throw `TypeError`; `h` still has no `a`, `img` or `iframe`.

A plugin without `asset` behaves as before. Pass `assets: [ids]` to `registerConsoleConformance` to check that those ids answer a served type.

### Review anchors

`ui.review` builds and places `ReviewAnchor` values from `@staix/agent-console/contract`; acon never stores an anchor or writes a file. The owning tool stores anchors unchanged and stays the authority.

- Documents: `{kind: "text" | "prose", path, text, contentHash, projection?}` or `{kind: "diff", path, unified, contentHash}`. Prose splits paragraphs on blank lines and shows Markdown as its source. All text renders as text. Up to 512 KB or 20,000 lines; more is cut with a notice.
- `contentHash` is the lowercase hex sha256 of the text the anchor was made against: the projected text when `projection` is set, else the raw file bytes.
- A new anchor has `lineRange` and `textQuote` (`exact` up to 2000 characters, `prefix`/`suffix` up to 64); a diff selection adds `diffHunk` and `side`. The kit displays but does not create `structural` and `region`.
- Placement: with the same `contentHash`, by `lineRange`; otherwise by a single `textQuote` match, with `prefix`/`suffix` breaking ties; otherwise unplaced. An ambiguous quote, a different projection, another path or an unknown selector kind is unplaced, never guessed. `onPlacement` reports `{threadId, placed, via: "hash" | "quote" | null}` per thread.
- Keyboard: Tab to the gutter, Up/Down/Home/End to move, Shift+Up/Down to extend, Enter to comment, Escape to clear.
- Bounds: 1 to 4 selectors per anchor, body up to 4000 characters, 200 threads per view. `reviewProblems(threads)`, `reviewThreadProblems` and `reviewAnchorProblems` from `@staix/agent-console/conformance` check them.
- Shared cases: `test/fixtures/review/cases.json` ships with the package so other tools (agent-hub) can run the same valid and invalid anchors, threads and hash cases; `expandReviewCase` and `reviewCaseValue` expand its compact `<N x c>` and `repeat` forms.

### Visuals

`ui.visual(payload)` takes a `VisualPayload` from `@staix/agent-console/contract`:

- `{kind: "mermaid", source, title?}`: the diagram renders only inside an `<iframe sandbox="allow-scripts">` served at `/visual/frame`. The frame has an opaque origin (no cookies, no storage, no access to the console) and its own CSP, `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`, which has no `connect-src`, so it cannot fetch anything. The console sends `{source, theme}` by `postMessage` and accepts only `{ok, height}` back from its own frame; the height is clamped to 80-2000 px. Mermaid runs with `securityLevel: "strict"`; the result is shown as an `<img>` of the SVG (a data URL), and the frame's own styles come from `/visual/frame.css`. `'unsafe-inline'` is there only for Mermaid's own measuring during render. The frame loads when the visual scrolls into view and is reused per panel. An empty or invalid source, a source over 20 KB, or a render over 5 s shows the source as text with a notice.
- `{kind: "comparison", title?, options}`: 2 to 6 options, each `{title, summary?, pros?, cons?, recommended?}` with at most 10 pros and 10 cons. The recommended option is marked by text and a double border, not color alone.
- `{kind: "table", caption?, columns, rows}`: the same as `ui.table`.
- `{kind: "beforeAfter", caption?, before, after}`: each side is `{text}` or `{asset, alt}` (a plugin asset, see "Plugin assets"); sides stack below 768 px.

The only CSP addition for visuals is the console's `frame-src 'self'`, shared with plugin assets. Mermaid follows the [vendored browser assets policy](#vendored-browser-assets): `@mermaid-js/tiny` 12.2.0 (2,811,424 bytes, MIT) ships in `shell/vendor/mermaid/`; `bun scripts/vendor-mermaid.ts` regenerates it and `bun scripts/vendor-mermaid.ts --check` verifies it. Shell icons follow the same policy: `@tabler/icons` 3.50.0 (MIT) outline path data ships in `shell/vendor/icons/`; `bun scripts/vendor-icons.ts` regenerates it from a fixed name list and `--check` verifies it.

Shared conformance data is exported as `VISUAL_CASES` (and type `VisualCase`) from `@staix/agent-console/visual-cases`. The list, payloads and verdicts are recursively frozen and have no runtime imports or DOM globals. Each entry is `{id, payload, expected: {valid: true} | {valid: false, field}}`; field paths use the same notation as `tableColumnProblems`, such as `columns[0].key`. Consumers run each payload through their validator and compare the verdict and failing field. An invalid contract case may still render: acon cuts oversized lists, falls back to source text for Mermaid, and throws for invalid asset ids or an unknown kind. Asset ids allow up to 512 UTF-16 code units. Its renderer tests exercise every shared case. The Mermaid bound counts UTF-16 code units (`source.length`), not encoded bytes; captions have no acon length bound (long-caption cases are valid). Extra consumer text or total-size ceilings remain consumer policy.

### Public styling contract

Panels may use these classes. Modifiers apply only with their base class:

- Lists and rows: `rows`, `row`, `row-main`, `row-text`, `row-title`, `row-sub`, `row-verbs`, `ui-rows`, `ui-row-open`.
- Controls and status: `btn` with `primary` or `danger` (what `ui.button` renders); `chip` with `ok`, `warn`, `err` or `accent`; `notice`; `ui-notice` with `ok`, `warn` or `err`.
- Containers and text: `empty`, `card`, `mono`, `ui-form`, `ui-field`.
- Details: `ui-detail`, `ui-detail-head`, `ui-detail-kind`, `ui-detail-move`, `ui-detail-actions`, `ui-detail-summary`, `ui-provenance`, `ui-detail-section`, `ui-detail-body`, `ui-detail-footer`.
- Tables and charts: `ui-table-block`, `ui-table-wrap`, `ui-table`, `ui-sort`, `ui-chart`, `ui-bars`, `ui-bar`, `ui-bar-label`, `ui-bar-value`, `ui-bar-track`, `ui-bar-fill`, `ui-bar-target`, `ui-spark`, `ui-spark-summary`, `ui-spark-line`, `ui-sr` (visually hidden).
- Assets and links: `ui-img`, `ui-frame`, `ui-link`.
- Review: `ui-review`, `ui-review-doc`, `ui-review-text`/`prose`/`diff`, `ui-review-unit`, `ui-review-gutter`, `ui-review-src`, `ui-review-add`, `ui-review-del`, `ui-review-hunk`, `ui-review-meta`, `ui-review-selected`, `ui-review-has-thread`, `ui-review-mark`, `ui-review-strip`, `ui-review-unplaced`, `ui-review-quote`, `ui-review-thread`, `ui-review-thread-body`, `ui-review-status`, `ui-review-box`, `ui-review-target`, `ui-review-input`.
- Visuals: `ui-visual`, `ui-visual-mermaid`, `ui-visual-frame`, `ui-visual-source`, `ui-visual-comparison`, `ui-visual-options`, `ui-visual-option` with `recommended`, `ui-visual-recommended`, `ui-visual-points` with `pros` or `cons`, `ui-visual-before-after`, `ui-visual-pair`, `ui-visual-side`, `ui-visual-text`.

The public CSS tokens are:

- Surfaces and text: `--acon-bg`, `--acon-surface`, `--acon-surface-2`, `--acon-line`, `--acon-line-2`, `--acon-line-control`, `--acon-text`, `--acon-text-2`.
- Accent and status: `--acon-accent`, `--acon-accent-soft`, `--acon-accent-text`, `--acon-on-accent`, `--acon-ok`, `--acon-ok-soft`, `--acon-warn`, `--acon-warn-soft`, `--acon-err`, `--acon-err-soft`, `--acon-focus`.
- Spacing: `--acon-space-1`, `--acon-space-2`, `--acon-space-3`, `--acon-space-4`, `--acon-space-5`, `--acon-space-6`.
- Shape and motion: `--acon-radius-1`, `--acon-radius-2`, `--acon-radius-3`, `--acon-shadow`, `--acon-ease`, `--acon-ease-out`, `--acon-duration-fast` (160 ms), `--acon-duration-normal` (300 ms), `--acon-duration-slow` (800 ms), `--acon-scrim`.
- Fonts: `--acon-font-ui`, `--acon-font-mono`.
- Type sizes: `--acon-text-2xs` (11), `--acon-text-xs` (12), `--acon-text-sm` (13), `--acon-text-md` (14), `--acon-text-base` (15), `--acon-text-lg` (16), `--acon-text-xl` (17), `--acon-text-2xl` (22). Values are rem, with the listed pixel equivalents at the default 16 px browser font size; spacing stays in px.

Radius rule: chips and `kbd` use `--acon-radius-1`; controls and rows use `--acon-radius-2`; sheets, dialogs and cards use `--acon-radius-3`. Counts are pills; circles and the 2 px stale-status dot are shape cues. `--acon-line-control` provides at least 3:1 contrast against the control surfaces in both themes; `--acon-line` and `--acon-line-2` retain their divider values. `--acon-scrim` adapts the modal backdrop to the theme. `--acon-ease` retains its existing combined duration/curve; new motion can use a duration token plus `--acon-ease-out`. Private `--shell-z-*` layer tokens are not part of this public contract.

Use the tokens in a plugin's own CSS for light and dark themes. `host.theme.tokens` exposes the color tokens; other tokens are available as CSS custom properties. Shell selectors outside the documented public classes are private and may change.

Check a plugin with the conformance suite:

```ts
import { registerConsoleConformance } from "@staix/agent-console/conformance";
registerConsoleConformance(plugin, { destructive: [{ action: "delete", id: "x" }] });
```

## Vendored browser assets

The published package has zero third-party runtime dependencies. Server and CLI code in `src/` imports only builtins (`node:`, `bun:`, `bun`) and relative files. Third-party browser assets may ship in `shell/vendor/` under these conditions:

- The source package is an exact `devDependencies` pin in `package.json`, never a runtime dependency.
- `scripts/vendor-<name>.ts` deterministically copies only the files the shell uses.
- A `manifest.json` records the package name, version and license, plus each shipped file's source path, byte count and SHA-256. `test/vendor-<name>.test.ts` pins those hashes and checks deterministic regeneration.
- The upstream license text ships in a `NOTICE` beside the files. Allowed licenses are MIT, ISC, BSD-2-Clause, BSD-3-Clause and Apache-2.0, plus OFL-1.1 for fonts only.
- Assets are served from the console origin only. Vendored code must not use a CDN, runtime network access, telemetry or `eval`. Loading from another origin remains forbidden for CSP, credential-free static builds and private-network use.
- Each asset over 100 KB loads lazily on first use. State any change to the total size of `shell/vendor/` in `CHANGELOG.md`.
- Code running in the shell document has the shell's authority, including tab credentials. Review each version bump like first-party code. A library that parses untrusted input runs in a sandboxed frame, as Mermaid does.

New libraries go in `shell/vendor/<name>/`. Three.js keeps its existing root layout. `bun scripts/check-boundary.ts` checks every vendor manifest's exact devDependency pin, allowed license and adjacent NOTICE; the vendor scripts, hash tests and review enforce the other conditions.

## Develop

```sh
bun install --frozen-lockfile
bun run check   # typecheck, boundary, README facts, doc stamps, tests, pack dry-run
```

README blocks between `<!-- facts:<name> -->` and `<!-- /facts:<name> -->` are generated: `bun scripts/readme-facts.ts` fails when one differs from `package.json`, `src/contract.ts`, `src/cli.ts` or the producer table in the script, and `--write` rewrites them. Edit the prose around them by hand. `docs/verified.json` records, per document, the commit its prose was last read against and the source paths it describes; `node scripts/check-docs.mjs` warns about a document whose paths changed after its stamp, and `--require-fresh` turns that into an error.

Before UI PRs, run `node scripts/ui-check.mjs`. It finds an existing Playwright install at run time, starts isolated fixture servers and writes screenshots plus `ui-check/report.json`. It checks 375/768/1024/1440 px, both themes and 100%/200% text, including Space with two tools, an explicit synthetic pet/pack and a no-pack fallback. A 1024 px touch context (`pointer: coarse`) in both themes checks that every button, rail link, tab, option and input is at least 44 px tall. Mini (`#/local/mini`) is captured in every cell, at the 320x440 pop-out size (light and dark, 100% and 200% text, rendered in the page, not a Picture-in-Picture window) and once with no pack and the pet off; it checks the pet sprite, Tab order with visible focus over item and footer buttons, and that a pet-less Mini requests nothing under `/pets/`. It checks namespace keys, roster parity, navigation and unchanged-poll DOM writes. It exits non-zero on browser errors, text clipping (including the search label), overlap or horizontal overflow. It also checks that the skip link is completely offscreen until focused, reachable by keyboard and moves focus to main when activated. Playwright is a development tool supplied by the person running the check, not a package dependency or CI gate.

The full probe also runs a two-node static-shell matrix at 375/1440 px in both themes and text sizes, checking node ownership, auth, offline and origin-refused states. `--static-only` runs that focused matrix. `--visual-only` runs an isolated `acon serve` Mermaid probe in light/dark themes, checking initially hidden frames with natural scheduling and suspended frame callbacks, malformed-source fallback and the source cap.

Use `PLAYWRIGHT_MODULE` for an absolute Playwright or playwright-core module path, `PLAYWRIGHT_EXECUTABLE_PATH` for an existing Chromium executable, and `BUN_BIN` for Bun when it is not on PATH. `--output <dir>` changes the artifact directory; `--baseline <report.json>` compares 100% text metrics against an earlier run (1 px tolerance). `--force-overflow` is a negative control and must exit non-zero. Use the workspace's remote runner when local browser workloads are deferred.

`--space-views-only` runs the Room/3D camera checks at 375 and 1440 px in both themes and 100%/200% text. It verifies lazy vendor requests, preserved focus order, projected overlay centres within 8 px after rotation, model loading, context-loss and absent-WebGL2 fallbacks, and zero additional canvas renders across a settled 10-second window. Depth-ordered scene buttons can occlude each other in projected views; their geometry and equivalent keyboard/roster access are checked separately from the shell's normal strict overlap checks. The full run includes both view and motion checks. For a separate published-art compatibility run, use `--space-views-only --art-root <directory>` with explicit `assets/` and `pets/` subdirectories; the probe never scans a real agent home.

Three.js 0.187.0 follows the [vendored browser assets policy](#vendored-browser-assets). To update it, change the version in `package.json` and `scripts/vendor-three.ts`, install it, then run `bun scripts/vendor-three.ts`. The script walks the module/GLTFLoader import graph and rewrites imports to relative paths using the installed TypeScript parser. Update the literal hashes in `test/vendor-three.test.ts` after reviewing the upstream change. The package dry-run reports the vendor size.

`--space-motion-only` runs the focused Space motion regression context. It changes public fixture facts through intercepted snapshot responses, checks actual CSS transitions and message consumption, and holds responses until the real snapshot gap exceeds 3 seconds. The normal full run includes this check as well as the viewport matrix.

Record a real macOS Safari/VoiceOver pass in the PR for inbox, peek, palette and confirm: focused element, announced role/name/state, keyboard result and any finding. DOM checks do not substitute for VoiceOver announcements; the owner decides whether a VoiceOver finding blocks merge.

## Release

A `v*` tag equal to `v` plus the `package.json` version publishes through `.github/workflows/release.yml`. The tag needs a dated `## [VERSION] - YYYY-MM-DD` section in `CHANGELOG.md`. Linux and macOS run `bun run check`, then stage one tarball, check its SHA-256 manifest and install it into a clean prefix. The publish job uploads that same Linux tarball with npm OIDC trusted publishing and provenance, and no npm token is used. It runs only when the repository variable `NPM_PUBLISH_ENABLED` is `true`, and only after a reviewer approves the `npm-production` environment. The trusted publisher is configured on npm for repository `STAIxBWLB/agent-console`, workflow `release.yml` and environment `npm-production`. A GitHub release with the CHANGELOG section and the tarball follows, and, when the `SITE_DISPATCH_TOKEN` secret is set, a `product-release` dispatch to STAIxBWLB/agent-hub-site (a failed dispatch does not fail the release). Never move a release tag or reuse a published version.

Create release tags only with `scripts/release-tag.ts`, never by hand. On a release branch, `bun scripts/release-tag.ts bump <version>` sets `package.json`, adds a dated CHANGELOG section under Unreleased and refreshes the README facts; merge that through a PR. Then, on a clean checkout of `origin/main`, `bun scripts/release-tag.ts tag --push` refuses an existing tag, a version mismatch or a missing dated entry, and only then creates and pushes `v<version>`. The release workflow's first job (`gate`) runs `bun scripts/release-gate.ts` on the tag commit before anything publishes: the tag must equal the version, the commit must be on `main` with a dated CHANGELOG entry, and the commit's push `Check` run must finish green within 20 minutes, else the release fails. The GitHub release step retries API calls on 5xx and 429 with a short backoff. Pull requests and `main` pushes report one aggregate check, `ci-ok`, which fails unless every gating job succeeded; it is the only check to require on `main`.

Before tagging, run `bun scripts/readme-facts.ts --write` after the version bump, then `node scripts/check-docs.mjs`. For each stale document, reread it against the source on `origin/main`, fix it, and set its `verifiedAgainst` in `docs/verified.json` to that `origin/main` commit (never a branch commit, which a squash merge drops). The release workflow runs `node scripts/check-docs.mjs --require-fresh` on the tagged commit and refuses to publish while any document is stale.

License: MIT
