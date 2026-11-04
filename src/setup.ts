import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * #45 follow-ups of `acon serve` (H1): a bearer token file and a macOS LaunchAgent.
 * Neither prints or embeds a token value.
 */

export const tokenPath = (home: string): string => join(home, "console", "token");

/**
 * Writes 32 random bytes as base64url, mode 0600. Without `force` the file is created with O_EXCL, so an existing
 * file (or a symlink) is refused and left as it was; with `force` a new file replaces it by rename.
 */
export function newTokenFile(path: string, force: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = `${randomBytes(32).toString("base64url")}\n`;
  const target = force ? `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp` : path;
  const fd = openSync(target, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600); // independent of the umask
    writeSync(fd, token);
  } catch (error) {
    closeSync(fd);
    rmSync(target, { force: true });
    throw error;
  }
  closeSync(fd);
  if (force) {
    try { renameSync(target, path); } catch (error) { rmSync(target, { force: true }); throw error; }
  }
}

export const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
/** Environment names `setup launchd` copies into the plist. ACON_TOKEN_FILE is a path; no token value is ever copied. */
export const LAUNCHD_ENV = ["ACON_TOKEN_FILE", "ACON_ACCESS_TEAM", "ACON_ACCESS_AUD", "ACON_ORIGINS", "ACON_PORT", "ACON_READ_ONLY"] as const;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const str = (s: string) => `<string>${xml(s)}</string>`;

export interface LaunchdOptions { label: string; bun: string; script: string; args: string[]; env: Record<string, string>; logDir: string }

/** A LaunchAgent that keeps `bun bin/acon.js serve ...` running, with logs under `logDir`. */
export function launchdPlist(o: LaunchdOptions): string {
  const env = Object.entries(o.env).map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t${str(v)}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${str(o.label)}
\t<key>ProgramArguments</key>
\t<array>
${[o.bun, o.script, "serve", ...o.args].map((a) => `\t\t${str(a)}`).join("\n")}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t${str(join(o.logDir, `${o.label}.out.log`))}
\t<key>StandardErrorPath</key>
\t${str(join(o.logDir, `${o.label}.err.log`))}
</dict>
</plist>
`;
}
