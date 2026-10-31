import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPets, petDirs } from "../src/pets.ts";
import { startServer } from "../src/server.ts";

const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8L"), Buffer.alloc(16)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const temps: string[] = [];
const servers: ReturnType<typeof startServer>[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function root() { const dir = mkdtempSync(join(tmpdir(), "acon-pets-")); temps.push(dir); return dir; }
function pkg(dir: string, name: string, manifest: Record<string, unknown>, sheet: Buffer | null = WEBP, file = "spritesheet.webp") {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "pet.json"), JSON.stringify(manifest));
  if (sheet) writeFileSync(join(dir, name, file), sheet);
}
const good = (id: string, extra: Record<string, unknown> = {}) => ({ id, displayName: id.toUpperCase(), spriteVersionNumber: 2, spritesheetPath: "spritesheet.webp", ...extra });

describe("loadPets", () => {
  test("reads valid Codex v2 packages, first directory wins", () => {
    const a = root(), b = root();
    pkg(a, "staix", good("staix", { description: "mascot" }));
    pkg(b, "staix", good("staix", { displayName: "Other" }));
    pkg(b, "gyul", good("gyul", { spritesheetPath: "sheet.png" }), PNG, "sheet.png");
    const { pets, problems } = loadPets([a, b, join(a, "missing")]);
    expect(problems).toEqual([]);
    expect(pets.map((p) => [p.id, p.name, p.type])).toEqual([["staix", "STAIX", "image/webp"], ["gyul", "GYUL", "image/png"]]);
    expect(pets[0]!.description).toBe("mascot");
  });

  test("skips and names invalid packages", () => {
    const dir = root();
    pkg(dir, "bad-id", good("Bad_Id"));
    pkg(dir, "v1", good("v1", { spriteVersionNumber: 1 }));
    pkg(dir, "slash", good("slash", { spritesheetPath: "../x.webp" }));
    pkg(dir, "magic", good("magic"), Buffer.from("GIF89a-not-an-image"));
    pkg(dir, "link", good("link"), null);
    symlinkSync(join(dir, "magic", "spritesheet.webp"), join(dir, "link", "spritesheet.webp"));
    pkg(dir, "huge", good("huge"));
    truncateSync(join(dir, "huge", "spritesheet.webp"), 8 * 1024 * 1024 + 1);
    const { pets, problems } = loadPets([dir]);
    expect(pets).toEqual([]);
    const why = (name: string) => problems.find((p) => p.startsWith(join(dir, name) + ":"));
    expect(why("bad-id")).toContain("id must match");
    expect(why("v1")).toContain("spriteVersionNumber");
    expect(why("slash")).toContain("spritesheetPath");
    expect(why("magic")).toContain("not a WebP or PNG");
    expect(why("link")).toContain("not a regular file");
    expect(why("huge")).toContain("larger than 8 MB");
  });

  test("looks in the console home, then CODEX_HOME, then ~/.codex", () => {
    expect(petDirs("/h", { CODEX_HOME: "/c" }, "/u")).toEqual(["/h/console/pets", "/c/pets", "/u/.codex/pets"]);
    expect(petDirs("/h", { CODEX_HOME: "/u/.codex" }, "/u")).toEqual(["/h/console/pets", "/u/.codex/pets"]);
    expect(petDirs("/h", {}, "/u")).toEqual(["/h/console/pets", "/u/.codex/pets"]);
  });
});

describe("pet routes", () => {
  test("/tools lists pets and the sheet needs a session", async () => {
    const dir = root();
    pkg(dir, "staix", good("staix"));
    const { pets, problems } = loadPets([dir]);
    const server = startServer({ plugins: [], version: "0", pluginsDir: "/tmp", log: () => {}, pets, petProblems: [...problems, "x: broken"] });
    servers.push(server);
    const anon = await fetch(`${server.origin}/pets/staix/sheet`);
    expect(anon.status).toBe(401);
    const ticket = server.issue().split("#")[1]!;
    const login = await fetch(`${server.origin}/session`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) });
    const cookie = /acon_ui_\d+=[0-9a-f]+/.exec(login.headers.get("set-cookie") ?? "")![0];
    const tools = await (await fetch(`${server.origin}/tools`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", Cookie: cookie }, body: "{}" })).json();
    expect(tools.pets).toEqual([{ id: "staix", name: "STAIX" }]);
    expect(tools.errors.some((e: { where: string; message: string }) => e.where === "pet package skipped" && e.message === "x: broken")).toBe(true);
    const sheet = await fetch(`${server.origin}/pets/staix/sheet`, { headers: { Cookie: cookie } });
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await sheet.arrayBuffer()).equals(WEBP)).toBe(true);
    expect((await fetch(`${server.origin}/pets/nope/sheet`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await fetch(`${server.origin}/pets/..%2Fx/sheet`, { headers: { Cookie: cookie } })).status).toBe(404);
    rmSync(join(dir, "staix", "spritesheet.webp"));
    symlinkSync("/etc/hosts", join(dir, "staix", "spritesheet.webp"));
    expect((await fetch(`${server.origin}/pets/staix/sheet`, { headers: { Cookie: cookie } })).status).toBe(404);
  });
});
