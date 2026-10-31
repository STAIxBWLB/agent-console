# Changelog

## [Unreleased]

### Added

- `acon ui` (H0): loopback console with a one-time link, session cookie, strict CSP and idle exit after 5 minutes.
- Plugin discovery from `$AGENTHUB_HOME/console/plugins/<tool>.json` with module hash and permission checks; `acon plugins` lists the result.
- Console plugin contract api 1 (`@staix/agent-console/contract`) with inbox, search, structured previews and undo, plus a conformance suite (`@staix/agent-console/conformance`).
- Verb reasons (`reason: "optional" | "required"`) asked inline and sent as `reason`; plugin palette commands (`manifest.commands`) that run through `action()`; a conformance check that inbox `at` stays stable; `onSnapshot` skips unchanged polls (#6).
- Confirm tokens for destructive actions: single use, 60 s, bound to session, tool and input.
- Shell: unified inbox with keyboard triage, peek sheet, command palette, confirm dialog, undo toast, System area, light and dark themes, tablet and phone layouts.
