// View controller shared by the CSS room and the optional, lazily imported WebGL view.
const STORAGE_KEY = "acon.space.roomView";
const radians = (degrees) => degrees * Math.PI / 180;
export function roomTransform(position, width, height, camera) {
  if (!position) return "";
  const { yaw, pitch } = camera;
  return `translate3d(${position.x + width / 2}px, ${position.y + height / 2}px, 2px) rotateZ(${-yaw}deg) rotateX(${-pitch}deg) translate(${-width / 2}px, ${-height}px)`;
}
/** Orthographic Room positions with enough screen-space separation for every billboard. */
export function roomGeometry(layout, actors, cards, camera, gap = 16) {
  const yaw = radians(camera.yaw), pitch = radians(camera.pitch);
  const cos = Math.cos(yaw), sin = Math.sin(yaw), tilt = Math.cos(pitch);
  const items = [actors, cards].flatMap((rows, index) => rows.flatMap((item) => {
    const kind = index ? "cards" : "actors", position = layout[kind].get(item.id);
    if (!position) return [];
    const x = position.x + item.width / 2, y = position.y + item.height / 2;
    return [{ ...item, kind, position, x: cos * x - sin * y, y: tilt * (sin * x + cos * y) }];
  }));
  let spacing = 1;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    // Billboard centers differ vertically by half their measured height. The
    // conservative vertical term covers that offset in either direction.
    const horizontal = ((a.width + b.width) / 2 + gap) / dx;
    const vertical = (Math.max(a.height, b.height) + gap) / dy;
    const needed = Math.min(horizontal, vertical);
    if (Number.isFinite(needed)) spacing = Math.max(spacing, needed);
  }
  const result = { width: layout.width * spacing, height: layout.height * spacing,
    actors: new Map(), cards: new Map(), zones: new Map(), spacing };
  for (const item of items) result[item.kind].set(item.id, {
    x: (item.position.x + item.width / 2) * spacing - item.width / 2,
    y: (item.position.y + item.height / 2) * spacing - item.height / 2,
  });
  for (const [id, position] of layout.zones) result.zones.set(id, { ...position, x: position.x * spacing, y: position.y * spacing, height: position.height * spacing });
  return result;
}
/** Keep relationship endpoints on the same visible avatar point in Flat and CSS Room. */
export function spaceLinkGeometry(layout, actors, link, camera) {
  const endpoint = (id) => {
    const position = layout.actors.get(id), metric = actors.find((item) => item.id === id);
    if (!position || !metric) return null;
    const x = position.x + metric.width / 2;
    if (!camera) return { x, y: position.y + 30 };
    const yaw = radians(camera.yaw), pitch = radians(camera.pitch);
    // The billboard inverse rotation keeps its pet center upright. Invert the
    // orthographic floor projection so the z=1 relationship reaches that same
    // point on the z=2 billboard, rather than the pre-refit floor position.
    const shift = (30 - metric.height - Math.sin(pitch)) / Math.cos(pitch);
    return { x: x + Math.sin(yaw) * shift, y: position.y + metric.height / 2 + Math.cos(yaw) * shift };
  };
  const from = endpoint(link.from), to = endpoint(link.to);
  if (!from || !to) return null;
  const dx = to.x - from.x, dy = to.y - from.y;
  return { from, to, width: Math.hypot(dx, dy), transform: `${camera ? "translate3d" : "translate"}(${from.x}px, ${from.y}px${camera ? ", 1px" : ""}) rotate(${Math.atan2(dy, dx)}rad)` };
}
export function createSpaceViewController(host) {
  const { root, plane, scroll, h } = host;
  const stage = h("div", { class: "space-stage" });
  plane.before(stage); stage.append(plane);
  const mount = h("div", { class: "space-webgl", "aria-hidden": "true", hidden: true });
  stage.prepend(mount);
  const fallback = h("p", { class: "notice space-view-notice", role: "status", hidden: true });
  const viewLabel = h("span", { text: "Scene style" });
  const choices = h("div", { class: "space-view-choices", role: "group", "aria-label": "Scene style" }, viewLabel);
  const controls = h("div", { class: "space-camera", role: "group", "aria-label": "Room camera" });
  const textView = h("button", { type: "button", class: "btn space-room-text-view", text: "Text view: Team", "data-space-focus": "text-team", onclick: () => host.onTextView?.() });
  const bar = h("div", { class: "space-view-bar" }, choices, controls, textView);
  const selection = h("p", { class: "space-selection sub", hidden: true });
  root.querySelector(".space-content").prepend(bar, selection, fallback);
  const setHidden = (element, hidden) => { if (element.hidden !== hidden) element.hidden = hidden; };
  const setAttribute = (element, name, value) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
  const setStyle = (element, name, value) => { if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value); };
  const removeStyle = (element, name) => { if (element.style.getPropertyValue(name)) element.style.removeProperty(name); };
  let available = false;
  try { const probe = document.createElement("canvas"); const context = probe.getContext("webgl2"); available = Boolean(context); context?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* Room is always available. */ }
  let view = "flat", saved = "flat";
  try { saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("acon.space.view") ?? "flat"; } catch { /* Storage may be disabled. */ }
  let state = null, webgl = null, lastReady = null, generation = 0, destroyed = false;
  let camera = { yaw: 45, pitch: 60, zoom: 1 };
  let cameraTouched = false, suspended = false, lastSize = "", lastTheme = "";
  const buttons = new Map();
  for (const [id, label] of [["flat", "Flat"], ["room", "Room"], ...(available ? [["3d", "3D"]] : [])]) {
    const button = h("button", { type: "button", class: "btn", text: label, "aria-label": `${label} scene style`, "data-space-view": id, "data-space-focus": `style:${id}`, "aria-pressed": "false", onclick: () => select(id) });
    choices.append(button); buttons.set(id, button);
  }
  const rotate = (step) => { cameraTouched = true; camera = { ...camera, yaw: camera.yaw + step }; apply(); };
  const zoom = (step) => { cameraTouched = true; camera = { ...camera, zoom: Math.max(.65, Math.min(1.35, Number((camera.zoom + step).toFixed(2)))) }; apply(); };
  controls.append(h("button", { type: "button", class: "btn", text: "Rotate left", "data-space-focus": "camera:left", onclick: () => rotate(-90) }),
    h("button", { type: "button", class: "btn", text: "Rotate right", "data-space-focus": "camera:right", onclick: () => rotate(90) }),
    h("button", { type: "button", class: "btn", text: "Zoom out", "data-space-focus": "camera:out", onclick: () => zoom(-.35) }),
    h("button", { type: "button", class: "btn", text: "Zoom in", "data-space-focus": "camera:in", onclick: () => zoom(.35) }));
  const onKey = (event) => {
    if (view === "flat" || event.target !== scroll || suspended || root.hidden || destroyed) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); rotate(event.key === "ArrowLeft" ? -90 : 90); }
    if (event.key === "+" || event.key === "-") { event.preventDefault(); zoom(event.key === "+" ? .35 : -.35); }
  };
  scroll.addEventListener("keydown", onKey);
  const describe = (event) => {
    const button = event.target.closest?.(".space-actor,.space-card");
    if (!button || view === "flat" || suspended || root.hidden) return;
    // Actor focus already has the full Team-facts popover; do not duplicate it in the camera bar.
    if (button.matches(".space-actor")) { setHidden(selection, true); return; }
    const text = button.getAttribute("aria-label");
    if (selection.textContent !== text) selection.textContent = text;
    setHidden(selection, false);
  };
  const clearDescription = (event) => {
    const active = document.activeElement;
    if (plane.contains(active) && active.matches(".space-actor,.space-card")) return;
    if (!event.relatedTarget || !plane.contains(event.relatedTarget)) setHidden(selection, true);
  };
  plane.addEventListener("focusin", describe); plane.addEventListener("pointerover", describe);
  plane.addEventListener("focusout", clearDescription); plane.addEventListener("pointerout", clearDescription);
  let lastProjection = null;
  const project = (projection) => {
    if (view !== "3d" || !state || suspended || destroyed || root.hidden) return;
    lastProjection = projection;
    for (const kind of ["actors", "cards"]) for (const point of projection[kind]) {
      const item = state[kind].find((row) => row.id === point.id);
      if (!item) continue;
      setStyle(item.el, "transform", `translate(${point.x - item.el.offsetWidth / 2}px, ${point.y - item.el.offsetHeight / 2}px)`);
      setAttribute(item.el, "data-projected-x", String(point.x)); setAttribute(item.el, "data-projected-y", String(point.y));
    }
    if (scroll.scrollLeft) scroll.scrollLeft = 0; if (scroll.scrollTop) scroll.scrollTop = 0;
  };
  const placeLinks = (layout, camera) => {
    for (const link of state.links ?? []) {
      const geometry = spaceLinkGeometry(layout, state.actors, link, camera);
      if (!geometry) continue;
      setStyle(link.el, "width", `${geometry.width}px`);
      setStyle(link.el, "transform", geometry.transform);
    }
  };
  function apply() {
    if (!state || destroyed || suspended || root.hidden) return;
    lastSize = `${scroll.clientWidth}:${scroll.clientHeight}`;
    lastTheme = getComputedStyle(root).color;
    setAttribute(root, "data-space-view", view); setAttribute(plane, "data-view", view);
    for (const [id, button] of buttons) setAttribute(button, "aria-pressed", String(id === view));
    const cameraFocused = controls.contains(document.activeElement);
    setHidden(controls, view === "flat"); setHidden(mount, view !== "3d");
    if (view === "flat" && cameraFocused) buttons.get("flat")?.focus({ preventScroll: true });
    setAttribute(scroll, "aria-label", view === "flat" ? "Collaboration scene, scroll to explore" : "Collaboration scene, arrow keys rotate, plus and minus zoom");
    removeStyle(scroll, "perspective");
    removeStyle(plane, "transform"); removeStyle(stage, "width"); removeStyle(stage, "height");
    if (view === "flat") {
      removeStyle(plane, "width"); removeStyle(plane, "min-width"); setStyle(plane, "height", `${state.layout.height}px`);
      for (const item of state.zones) removeStyle(item.el, "transform-origin");
      placeLinks(state.layout);
      for (const kind of ["actors", "cards", "zones"]) for (const item of state[kind]) {
        const position = state.layout[kind].get(item.id);
        if (!position) continue;
        item.el.style.transform = `translate(${position.x}px, ${position.y}px)`;
      }
      return;
    }
    if (view === "room") {
      const geometry = roomGeometry(state.layout, state.actors, state.cards, camera);
      const { width, height } = geometry;
      placeLinks(geometry, camera);
      const scale = camera.zoom, pad = 24;
      // Orthographic isometric projection keeps measured billboard separation exact.
      setStyle(scroll, "perspective", "none");
      setStyle(plane, "width", `${width}px`); setStyle(plane, "min-width", `${width}px`); setStyle(plane, "height", `${height}px`);
      // Frame the camera on what it actually shows: project the plane corners and every billboard's corners
      // through the same orthographic transforms, then offset the plane so
      // nothing lands above or left of the scroll box, where it could not be scrolled to.
      const camera3d = `scale(${scale}) rotateX(${camera.pitch}deg) rotateZ(${camera.yaw}deg) translate(${-width / 2}px, ${-height}px)`;
      const planeMatrix = new DOMMatrix(camera3d);
      const xs = [], ys = [];
      const add = (matrix, w, hgt) => { for (const [x, y] of [[0, 0], [w, 0], [0, hgt], [w, hgt]]) { const p = matrix.transformPoint(new DOMPoint(x, y, 0, 1)); xs.push(p.x / (p.w || 1)); ys.push(p.y / (p.w || 1)); } };
      add(planeMatrix, width, height);
      for (const kind of ["actors", "cards"]) for (const item of state[kind]) {
        const position = geometry[kind].get(item.id);
        if (!position) continue;
        const transform = roomTransform(position, item.width, item.height, camera);
        item.el.style.transform = transform;
        add(planeMatrix.multiply(new DOMMatrix(transform)), item.width, item.height);
      }
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const stageWidth = Math.max(scroll.clientWidth - 2, maxX - minX + pad * 2), stageHeight = maxY - minY + pad * 2;
      const offsetX = (stageWidth - (maxX - minX)) / 2 - minX, offsetY = pad - minY;
      stage.style.width = `${stageWidth}px`; stage.style.height = `${stageHeight}px`;
      plane.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0) ${camera3d}`;
      for (const item of state.zones) { const p = geometry.zones.get(item.id); if (!p) continue; setStyle(item.el, "transform-origin", "0 0"); setStyle(item.el, "transform", `translate3d(${p.x}px, ${p.y}px, 1px) scale(${geometry.spacing})`); }
      scroll.scrollLeft = Math.max(0, (stageWidth - scroll.clientWidth) / 2);
      if (scroll.scrollTop) scroll.scrollTop = 0;
      lastSize = `${scroll.clientWidth}:${scroll.clientHeight}`;
      return;
    }
    if (scroll.scrollLeft) scroll.scrollLeft = 0; if (scroll.scrollTop) scroll.scrollTop = 0;
    // The viewport grid gives the scroller exactly the remaining Room height.
    const width = Math.max(1, scroll.clientWidth - 2);
    const height = Math.max(1, scroll.clientHeight - 2);
    stage.style.width = `${width}px`; stage.style.height = `${height}px`;
    plane.style.width = `${width}px`; plane.style.minWidth = "0"; plane.style.height = `${height}px`;
    lastSize = `${scroll.clientWidth}:${scroll.clientHeight}`;
    if (webgl) {
      // On a portrait canvas the wide layout fits best with its long axis running down the screen.
      if (!cameraTouched) camera = { ...camera, yaw: width < height ? 90 : 45 };
      const input = { ...state, width, height, theme: getComputedStyle(root).color };
      webgl.update(input); webgl.setCamera(camera);
      // A forced refresh with unchanged facts resets the buttons to flat coordinates, but the renderer then draws
      // nothing new, so put them back on the last projection now; a fresh draw will overwrite it if one follows.
      if (lastProjection) project(lastProjection);
      const current = webgl, turn = generation;
      const ready = current.ready;
      if (ready !== lastReady) { lastReady = ready; delete mount.dataset.ready; }
      ready.then(() => { if (!destroyed && current === webgl && turn === generation && ready === current.ready && view === "3d") mount.dataset.ready = "true"; });
    }
  }
  async function select(next, message = "") {
    const id = ++generation;
    view = next === "3d" && !available ? "room" : next; setHidden(selection, true);
    try { localStorage.setItem(STORAGE_KEY, view); } catch { /* Optional persistence. */ }
    if (next === "3d" && !available) message = "3D is unavailable. Room view is active.";
    setHidden(fallback, !message); if (fallback.textContent !== message) fallback.textContent = message;
    if (view !== "3d") { webgl?.destroy(); webgl = null; lastReady = null; lastProjection = null; mount.replaceChildren(); delete mount.dataset.ready; }
    plane.style.removeProperty("width"); plane.style.removeProperty("min-width");
    if (state) plane.style.height = `${state.layout.height}px`;
    apply();
    if (view === "3d" && !webgl && !suspended) {
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
  const resize = new ResizeObserver(() => {
    if (destroyed || suspended || root.hidden || view === "flat") return;
    const size = `${scroll.clientWidth}:${scroll.clientHeight}`;
    if (size !== lastSize) apply();
  }); resize.observe(scroll);
  const theme = new MutationObserver(() => { if (!destroyed && !suspended && !root.hidden && view === "3d" && getComputedStyle(root).color !== lastTheme) apply(); }); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return {
    update(next) { suspended = false; state = next; if (!root.dataset.spaceView) select(["flat", "room", "3d"].includes(saved) ? saved : "flat"); else if (view === "3d" && !webgl) select("3d"); else apply(); },
    suspend() { if (suspended) return; suspended = true; setHidden(selection, true); generation += 1; webgl?.destroy(); webgl = null; lastReady = null; lastProjection = null; mount.replaceChildren(); delete mount.dataset.ready; },
    select,
    get stats() { return { view, renderCount: webgl?.renderCount ?? 0, pendingFrames: webgl?.pendingFrames ?? 0, modelCount: webgl?.modelCount ?? 0, boxCount: webgl?.boxCount ?? 0 }; },
    destroy() { destroyed = true; generation += 1; resize.disconnect(); theme.disconnect(); scroll.removeEventListener("keydown", onKey); webgl?.destroy(); plane.removeEventListener("focusin", describe); plane.removeEventListener("pointerover", describe); plane.removeEventListener("focusout", clearDescription); plane.removeEventListener("pointerout", clearDescription); bar.remove(); selection.remove(); fallback.remove(); }
  };
}
