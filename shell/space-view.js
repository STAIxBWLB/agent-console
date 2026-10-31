// View controller shared by the CSS room and the optional, lazily imported WebGL view.
const STORAGE_KEY = "acon.space.view";
const radians = (degrees) => degrees * Math.PI / 180;
export function roomTransform(position, width, height, camera) {
  const { yaw, pitch } = camera;
  return `translate3d(${position.x + width / 2}px, ${position.y + height / 2}px, 2px) rotateZ(${-yaw}deg) rotateX(${-pitch}deg) translate(${-width / 2}px, ${-height}px)`;
}
export function createSpaceViewController(host) {
  const { root, plane, scroll, h } = host;
  const stage = h("div", { class: "space-stage" });
  plane.before(stage); stage.append(plane);
  const mount = h("div", { class: "space-webgl", "aria-hidden": "true", hidden: true });
  stage.prepend(mount);
  const fallback = h("p", { class: "notice space-view-notice", role: "status", hidden: true });
  const viewLabel = h("span", { text: "View" });
  const choices = h("div", { class: "space-view-choices", role: "group", "aria-label": "Space view" }, viewLabel);
  const controls = h("div", { class: "space-camera", role: "group", "aria-label": "Room camera" });
  const bar = h("div", { class: "space-view-bar" }, choices, controls);
  const selection = h("p", { class: "space-selection sub", hidden: true });
  root.querySelector(".space-content").before(bar, selection, fallback);
  let available = false;
  try { const probe = document.createElement("canvas"); const context = probe.getContext("webgl2"); available = Boolean(context); context?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* Room is always available. */ }
  let view = "flat", saved = "flat";
  try { saved = localStorage.getItem(STORAGE_KEY) ?? "flat"; } catch { /* Storage may be disabled. */ }
  let state = null, webgl = null, lastReady = null, generation = 0, destroyed = false;
  let camera = { yaw: 45, pitch: 60, zoom: 1 };
  let cameraTouched = false;
  const buttons = new Map();
  for (const [id, label] of [["flat", "Flat"], ["room", "Room"], ...(available ? [["3d", "3D"]] : [])]) {
    const button = h("button", { type: "button", class: "btn", text: label, "data-space-view": id, "aria-pressed": "false", onclick: () => select(id) });
    choices.append(button); buttons.set(id, button);
  }
  const rotate = (step) => { cameraTouched = true; camera = { ...camera, yaw: camera.yaw + step }; apply(); };
  const zoom = (step) => { cameraTouched = true; camera = { ...camera, zoom: Math.max(.65, Math.min(1.35, Number((camera.zoom + step).toFixed(2)))) }; apply(); };
  controls.append(h("button", { type: "button", class: "btn", text: "Rotate left", onclick: () => rotate(-90) }),
    h("button", { type: "button", class: "btn", text: "Rotate right", onclick: () => rotate(90) }),
    h("button", { type: "button", class: "btn", text: "Zoom out", onclick: () => zoom(-.35) }),
    h("button", { type: "button", class: "btn", text: "Zoom in", onclick: () => zoom(.35) }));
  const onKey = (event) => {
    if (view === "flat" || event.target !== scroll) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); rotate(event.key === "ArrowLeft" ? -90 : 90); }
    if (event.key === "+" || event.key === "-") { event.preventDefault(); zoom(event.key === "+" ? .35 : -.35); }
  };
  scroll.addEventListener("keydown", onKey);
  const describe = (event) => {
    const button = event.target.closest?.(".space-actor,.space-card");
    if (!button || view === "flat") return;
    selection.textContent = button.getAttribute("aria-label"); selection.hidden = false;
  };
  const clearDescription = (event) => {
    const active = document.activeElement;
    if (plane.contains(active) && active.matches(".space-actor,.space-card")) return;
    if (!event.relatedTarget || !plane.contains(event.relatedTarget)) selection.hidden = true;
  };
  plane.addEventListener("focusin", describe); plane.addEventListener("pointerover", describe);
  plane.addEventListener("focusout", clearDescription); plane.addEventListener("pointerout", clearDescription);
  const project = (projection) => {
    if (view !== "3d" || !state) return;
    for (const kind of ["actors", "cards"]) for (const point of projection[kind]) {
      const item = state[kind].find((row) => row.id === point.id);
      if (!item) continue;
      item.el.style.transform = `translate(${point.x - item.el.offsetWidth / 2}px, ${point.y - item.el.offsetHeight / 2}px)`;
      item.el.dataset.projectedX = String(point.x); item.el.dataset.projectedY = String(point.y);
    }
    scroll.scrollLeft = 0; scroll.scrollTop = 0;
  };
  function apply() {
    if (!state || destroyed) return;
    root.dataset.spaceView = view; plane.dataset.view = view;
    for (const [id, button] of buttons) button.setAttribute("aria-pressed", String(id === view));
    controls.hidden = view === "flat"; mount.hidden = view !== "3d";
    scroll.setAttribute("aria-label", view === "flat" ? "Collaboration scene, scroll to explore" : "Collaboration scene, arrow keys rotate, plus and minus zoom");
    scroll.style.removeProperty("perspective");
    plane.style.removeProperty("transform"); stage.style.removeProperty("width"); stage.style.removeProperty("height");
    if (view === "flat") {
      for (const kind of ["actors", "cards", "zones"]) for (const item of state[kind]) {
        const position = state.layout[kind].get(item.id);
        item.el.style.transform = `translate(${position.x}px, ${position.y}px)`;
      }
      return;
    }
    if (view === "room") {
      const width = state.layout.width, height = state.layout.height;
      const scale = camera.zoom, pad = 24;
      scroll.style.perspective = `${Math.max(4000, Math.hypot(width, height) * 12)}px`;
      plane.style.width = `${width}px`; plane.style.minWidth = `${width}px`;
      // Frame the camera on what it actually shows: project the plane corners and every billboard's corners
      // through the same transforms (the long perspective is close to orthographic), then offset the plane so
      // nothing lands above or left of the scroll box, where it could not be scrolled to.
      const camera3d = `scale(${scale}) rotateX(${camera.pitch}deg) rotateZ(${camera.yaw}deg) translate(${-width / 2}px, ${-height}px)`;
      const planeMatrix = new DOMMatrix(camera3d);
      const xs = [], ys = [];
      const add = (matrix, w, hgt) => { for (const [x, y] of [[0, 0], [w, 0], [0, hgt], [w, hgt]]) { const p = matrix.transformPoint(new DOMPoint(x, y, 0, 1)); xs.push(p.x / (p.w || 1)); ys.push(p.y / (p.w || 1)); } };
      add(planeMatrix, width, height);
      for (const kind of ["actors", "cards"]) for (const item of state[kind]) {
        const transform = roomTransform(state.layout[kind].get(item.id), item.width, item.height, camera);
        item.el.style.transform = transform;
        add(planeMatrix.multiply(new DOMMatrix(transform)), item.width, item.height);
      }
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const stageWidth = Math.max(scroll.clientWidth - 2, maxX - minX + pad * 2), stageHeight = maxY - minY + pad * 2;
      const offsetX = (stageWidth - (maxX - minX)) / 2 - minX, offsetY = pad - minY;
      stage.style.width = `${stageWidth}px`; stage.style.height = `${stageHeight}px`;
      plane.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0) ${camera3d}`;
      for (const item of state.zones) { const p = state.layout.zones.get(item.id); item.el.style.transform = `translate3d(${p.x}px, ${p.y}px, 1px)`; }
      scroll.scrollLeft = Math.max(0, (stageWidth - scroll.clientWidth) / 2);
      scroll.scrollTop = 0;
      return;
    }
    scroll.scrollLeft = 0; scroll.scrollTop = 0;
    const width = Math.max(280, scroll.clientWidth - 2), height = Math.max(480, Math.min(720, window.innerHeight * .65));
    stage.style.width = `${width}px`; stage.style.height = `${height}px`;
    plane.style.width = `${width}px`; plane.style.minWidth = "0"; plane.style.height = `${height}px`;
    if (webgl) {
      // On a portrait canvas the wide layout fits best with its long axis running down the screen.
      if (!cameraTouched) camera = { ...camera, yaw: width < height ? 90 : 45 };
      const input = { ...state, width, height, theme: getComputedStyle(root).color };
      webgl.update(input); webgl.setCamera(camera);
      const current = webgl, turn = generation;
      const ready = current.ready;
      if (ready !== lastReady) { lastReady = ready; delete mount.dataset.ready; }
      ready.then(() => { if (!destroyed && current === webgl && turn === generation && ready === current.ready && view === "3d") mount.dataset.ready = "true"; });
    }
  }
  async function select(next, message = "") {
    const id = ++generation;
    view = next === "3d" && !available ? "room" : next; selection.hidden = true;
    try { localStorage.setItem(STORAGE_KEY, view); } catch { /* Optional persistence. */ }
    if (next === "3d" && !available) message = "3D is unavailable. Room view is active.";
    fallback.hidden = !message; fallback.textContent = message;
    if (view !== "3d") { webgl?.destroy(); webgl = null; lastReady = null; mount.replaceChildren(); delete mount.dataset.ready; }
    plane.style.removeProperty("width"); plane.style.removeProperty("min-width");
    if (state) plane.style.height = `${state.layout.height}px`;
    apply();
    if (view === "3d" && !webgl) {
      try {
        const { createSpace3D } = await import("/space3d.js");
        if (id !== generation || destroyed) return;
        const created = await createSpace3D({ mount, onProjection: project, onCamera: (next) => { cameraTouched = true; camera = next; }, onFallback: () => select("room", "3D is unavailable. Room view is active.") });
        if (id !== generation || destroyed) { created.destroy(); return; }
        webgl = created; apply();
      } catch (error) {
        host.onError?.(error);
        if (id === generation && !destroyed) select("room", "3D is unavailable. Room view is active.");
      }
    }
  }
  const resize = new ResizeObserver(() => { if (view !== "flat") apply(); }); resize.observe(scroll);
  const theme = new MutationObserver(() => { if (view === "3d") apply(); }); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return {
    update(next) { state = next; if (!root.dataset.spaceView) select(["flat", "room", "3d"].includes(saved) ? saved : "flat"); else apply(); },
    select,
    get stats() { return { view, renderCount: webgl?.renderCount ?? 0, pendingFrames: webgl?.pendingFrames ?? 0, modelCount: webgl?.modelCount ?? 0, boxCount: webgl?.boxCount ?? 0 }; },
    destroy() { destroyed = true; generation += 1; resize.disconnect(); theme.disconnect(); scroll.removeEventListener("keydown", onKey); webgl?.destroy(); plane.removeEventListener("focusin", describe); plane.removeEventListener("pointerover", describe); plane.removeEventListener("focusout", clearDescription); plane.removeEventListener("pointerout", clearDescription); bar.remove(); selection.remove(); fallback.remove(); }
  };
}
