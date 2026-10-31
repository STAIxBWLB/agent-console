# Review

- Compare the complete diff with the linked issue's acceptance criteria and its out-of-scope list.
- Session: single-use 60 s tickets, HttpOnly SameSite=Strict cookie, exact Host and Origin match, POST JSON data routes, 32 KB bodies, CSP without inline code or remote origins.
- Plugins: manifests are hash-checked before import, stale or invalid ones are listed and not loaded, the plugin directory and manifests must not be writable by others, one failing plugin never blocks the others.
- Confirm: tokens are single use, expire after 60 s and are bound to session, tool and canonical input; the page cannot send `confirmed` or `fingerprint`; drift returns a fresh preview instead of writing.
- Errors: content areas show one-line summaries; provider exception text reaches System and the terminal only.
- Shell: data rendered as text, keyboard path for every action, visible focus, both themes, phone layout without horizontal scroll.
- Require typecheck, boundary check, tests and package dry-run. Distinguish local evidence from hosted Linux/macOS CI and from browser checks.
- For UI changes, attach the `scripts/ui-check.mjs` JSON report and screenshots (375/768/1024/1440 px, light/dark, 100%/200% text), plus the forced-overflow negative-control result. Record actual Safari/VoiceOver announcements for inbox, peek, palette and confirm; mark unverified entries explicitly and leave blocking findings to the owner.
