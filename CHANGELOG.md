# Changelog

## [Unreleased]

### Fixed

- Plugin discovery scans files that start with a `#!` line (CLI entry files) instead of marking the plugin "cannot be read"; a file that cannot be scanned is now named in the reason. The stripped line ends at any JavaScript line terminator (LF, CR, U+2028, U+2029), so an import after a CR-terminated `#!` is still checked.

### Added

- Repeatable UI checks across phone, tablet and desktop widths, both themes and 200% text; rem type tokens, discoverable scrolling tabs and inline status chips on phones (#7).
- `host.ui` panel kit with text-only elements, forms, keyboard-navigable rows and a shared detail template; documented public CSS classes and tokens (#5).
- `acon ui` (H0): loopback console with a one-time link, session cookie, strict CSP and idle exit after 5 minutes.
- Plugin discovery from `$AGENTHUB_HOME/console/plugins/<tool>.json` with module hash and permission checks; `acon plugins` lists the result.
- Console plugin contract api 1 (`@staix/agent-console/contract`) with inbox, search, structured previews and undo, plus a conformance suite (`@staix/agent-console/conformance`).
- Verb reasons (`reason: "optional" | "required"`) asked inline and sent as `reason`; plugin palette commands (`manifest.commands`) that run through `action()`; a conformance check that inbox `at` stays stable; `onSnapshot` skips unchanged polls (#6).
- Confirm tokens for destructive actions: single use, 60 s, bound to session, tool and input.
- Shell: unified inbox with keyboard triage, peek sheet, command palette, confirm dialog, undo toast, System area, light and dark themes, tablet and phone layouts.
