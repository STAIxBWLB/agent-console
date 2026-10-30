import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const shell = (name: string) => readFileSync(join(import.meta.dir, "..", "shell", name), "utf8");

describe("shell files fit the CSP", () => {
  test("index.html has no inline script, style or handlers", () => {
    const html = shell("index.html");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  test("shell.js is a module that never writes markup from data", () => {
    const js = shell("shell.js");
    expect(() => new Bun.Transpiler({ loader: "js" }).scan(js)).not.toThrow();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(js).not.toMatch(/setAttribute\(\s*["']style/);
  });

  test("nothing loads from another origin", () => {
    for (const name of ["index.html", "shell.js", "shell.css"]) {
      const text = shell(name).replaceAll("http://www.w3.org/2000/svg", "");
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/@import/);
    }
  });
});
