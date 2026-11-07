import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const shell = join(import.meta.dir, "..", "shell");
const css = readFileSync(join(shell, "shell.css"), "utf8");

// These stylesheets use flat declaration rules inside media/keyframe blocks, with
// no CSS nesting. Inspect leaf rules so at-rule wrappers cannot hide declarations.
function rules(source: string) {
  return [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => {
    const declarations: Record<string, string> = {};
    for (const entry of match[2]!.split(";")) {
      const colon = entry.indexOf(":");
      if (colon > -1) declarations[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
    }
    return { selector: match[1]!.trim(), declarations };
  });
}

function designProblems(source: string) {
  const problems: string[] = [];
  for (const { selector, declarations } of rules(source)) {
    const tokens = /^:root(?:\[|:|$)/.test(selector);
    for (const [property, value] of Object.entries(declarations)) {
      if (!tokens && /#[0-9a-f]{3,8}\b|\brgba?\(/i.test(value)) problems.push(`${selector}: literal color`);
      if (property.startsWith("--")) continue;
      if (/^border-(?:left|right|top|bottom|inline-start|inline-end|block-start|block-end)(?:-color)?$/.test(property)) {
        // Thin line-token dividers, selected-tab underline and the Space data
        // connector are functional, documented exceptions, never card accents.
        const width = /([\d.]+)px/.exec(value);
        const divider = /var\(--acon-line(?:-2|-control)?\)/.test(value) && (!width || Number(width[1]) <= 2);
        const functional = selector === '.tab[aria-selected="true"]' || selector === ".space-link";
        if (!divider && !functional && !/^(?:0|none)$/.test(value) && !/\btransparent\b/.test(value)) problems.push(`${selector}: one-sided border`);
      }
      if (property === "box-shadow" && /\binset\b/.test(value)) problems.push(`${selector}: inset shadow`);
      if (property === "z-index" && !/^(?:auto|var\(--shell-z-[a-z-]+\))$/.test(value)) problems.push(`${selector}: literal layer`);
      if (/^(?:transition|animation)(?:-|$)/.test(property) && /(?:\d*\.)?\d+m?s\b|\b(?:ease|linear|steps|cubic-bezier)\b/.test(value.replace(/var\([^)]+\)/g, ""))) problems.push(`${selector}: literal motion`);
      if (property === "border-radius" && /\b(?:4|10)px\b/.test(value)) problems.push(`${selector}: literal corner`);
    }
    // The tab overflow fades and transformed Room wall are functional geometry,
    // documented in shell.css. Other painted generated elements need review so
    // a band cannot evade the border rule by changing its width or using tokens.
    const tabFade = selector.split(",").every((part) => /^\.tabs::(?:before|after)$/.test(part.trim()));
    const roomWall = selector === '[data-space-view="room"] .space-plane::after';
    if (/::(?:before|after)/.test(selector) && !tabFade && !roomWall && declarations.content !== undefined && /background/.test(Object.keys(declarations).join(" "))) {
      problems.push(`${selector}: pseudo-element band`);
    }
  }
  return problems;
}

function tokens(selector: string) {
  return rules(css).find((rule) => rule.selector === selector)!.declarations;
}

function contrast(a: string, b: string) {
  const luminance = (hex: string) => [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
    const value = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return sum + weight * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  }, 0);
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("shell design guard (#71 PR1)", () => {
  test("every shell stylesheet follows the band/color/motion/layer rules", () => {
    for (const file of readdirSync(shell).filter((name) => name.endsWith(".css"))) {
      expect({ file, problems: designProblems(readFileSync(join(shell, file), "utf8")) }).toEqual({ file, problems: [] });
    }
  });

  test("explicit and system dark token blocks stay identical", () => {
    expect(tokens(':root[data-theme="dark"]')).toEqual(tokens(':root:not([data-theme="light"])'));
  });

  test("negative controls detect each forbidden design regression", () => {
    for (const rule of [
      ".bad { border-left: 3px solid var(--acon-accent); }",
      ".bad { border-top-color: var(--acon-warn); }",
      ".bad { border-right: 3px solid var(--acon-line); }",
      ".bad { box-shadow: inset 3px 0 var(--acon-accent); }",
      '.bad::before { content: ""; width: 3px; height: 100%; background: var(--acon-accent); }',
      ".bad { color: #ffffff; }", ".bad { background: rgb(0 0 0 / .5); }",
      ".bad { transition: transform 0.3s ease; }", ".bad { z-index: 20; }", ".bad { border-radius: 10px; }",
    ]) expect(designProblems(`${css}\n${rule}`).length).toBeGreaterThan(0);
    const drift = css.replace('    --acon-bg: #0E1116;', '    --acon-bg: #111111;');
    const darkRules = rules(drift);
    expect(darkRules.find((r) => r.selector === ':root[data-theme="dark"]')!.declarations)
      .not.toEqual(darkRules.find((r) => r.selector === ':root:not([data-theme="light"])')!.declarations);
  });

  test("control boundaries meet 3:1 across both theme surfaces", () => {
    for (const palette of [tokens(":root"), tokens(':root[data-theme="dark"]')]) {
      for (const background of ["bg", "surface", "surface-2", "accent-soft", "warn-soft"]) {
        expect(contrast(palette["--acon-line-control"]!, palette[`--acon-${background}`]!)).toBeGreaterThanOrEqual(3);
      }
      for (const [text, background] of [["text", "surface"], ["text-2", "bg"], ["accent-text", "accent-soft"], ["warn", "warn-soft"]]) {
        expect(contrast(palette[`--acon-${text}`]!, palette[`--acon-${background}`]!)).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const selector of ["kbd", ".btn", ".search-open", ".ui-field input", ".ui-review-input", ".typed input", ".reason-row input", ".answer-other-text", ".space-card", ".space-actor"]) {
      const rule = rules(css).find((item) => item.selector === selector)!;
      expect(rule.declarations.border).toContain("var(--acon-line-control)");
    }
  });

  test("legacy ease and global reduced-motion override remain", () => {
    expect(tokens(":root")["--acon-ease"]).toBe("160ms cubic-bezier(0.2, 0, 0, 1)");
    expect(css).toContain("*, *::before, *::after { transition: none !important; animation: none !important;");
    expect(css).toContain("Radius rule:");
  });
});
