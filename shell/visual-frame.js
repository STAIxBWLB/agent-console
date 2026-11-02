// acon visual frame (#29). Runs in a sandbox="allow-scripts" iframe: opaque origin, no cookies, no storage and,
// by its own CSP, no network. It renders one Mermaid source per message and reports only {ok, height} or an error.
"use strict";
(() => {
  const MAX_SOURCE = 20 * 1024;
  const root = document.getElementById("diagram");
  let seq = 0;
  const reply = (msg) => parent.postMessage({ acon: "visual", ...msg }, "*");
  // The vendored IIFE build assigns globalThis.mermaid.
  const mermaid = typeof globalThis.mermaid?.render === "function" ? globalThis.mermaid : null;
  const ready = mermaid !== null;
  // The page's own content height: body padding plus the image box.
  const height = () => Math.ceil(document.body.getBoundingClientRect().height) + 2;
  /** Width and height from the SVG's viewBox (Mermaid always sets one), read without parsing it into this page. */
  function size(svg) {
    const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
    return box ? { w: Number(box[1]), h: Number(box[2]) } : null;
  }
  async function render(data) {
    const id = Number(data.id);
    const source = typeof data.source === "string" ? data.source : "";
    if (!mermaid) return reply({ id, ok: false, error: "renderer unavailable" });
    if (!source || source.length > MAX_SOURCE) return reply({ id, ok: false, error: "source is empty or over 20 KB" });
    const dark = data.theme === "dark";
    try {
      document.documentElement.className = dark ? "dark" : "light";
      // Inline styles are allowed only in this frame (style-src 'unsafe-inline'); the parent shell has none.
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document.body.style.margin = "0";
      document.body.style.padding = "8px";
      document.body.style.background = dark ? "#16181d" : "#ffffff";
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", darkMode: dark,
        // Edge labels sit on a box that matches the canvas, so they stay readable in dark mode.
        themeVariables: dark ? { edgeLabelBackground: "#16181d", textColor: "#e6e8ee" } : { edgeLabelBackground: "#ffffff" }, htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: "system-ui, sans-serif" });
      // Mermaid lays out in its own temporary element during render(); this page assigns no markup. The result is
      // shown as an image of the SVG, which runs no script and loads nothing (FRAME_CSP allows img-src data: only).
      const { svg } = await mermaid.render(`acon-visual-${++seq}`, source);
      const img = document.createElement("img");
      img.alt = typeof data.title === "string" && data.title ? data.title : "Diagram";
      const dims = size(svg);
      if (dims) { img.width = Math.round(dims.w); img.height = Math.round(dims.h); }
      img.style.display = "block";
      img.style.maxWidth = "100%";
      img.style.height = "auto";
      img.style.margin = "0 auto";
      await new Promise((done) => { img.onload = done; img.onerror = done; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; });
      root.replaceChildren(img);
      root.setAttribute("aria-label", img.alt);
      requestAnimationFrame(() => reply({ id, ok: true, height: height() }));
    } catch (error) {
      root.replaceChildren();
      reply({ id, ok: false, error: String(error && error.message ? error.message : error).split("\n")[0].slice(0, 200) });
    }
  }
  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.acon !== "visual-render") return;
    void render(data);
  });
  reply({ ready: true, ok: ready });
})();
