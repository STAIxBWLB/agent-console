// Loaded only after the browser's user chooses 3D. All assets stay on this origin.
import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";

const UNIT = 100;
const rows = { idle: [0, 6], working: [7, 6], waiting: [6, 6], blocked: [5, 8], away: [0, 6] };
const hash = (text) => [...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
const radians = (degrees) => degrees * Math.PI / 180;

/** The stock loader fetches blob URLs for embedded images. Decode bytes directly under the shell CSP. */
function embeddedImages(parser) {
  const cache = new Map();
  return { name: "ACON_embedded_images", beforeRoot() {
    parser.loadImageSource = (index) => {
      if (!cache.has(index)) cache.set(index, (async () => {
        const image = parser.json.images[index];
        let blob;
        if (image.bufferView !== undefined) {
          blob = new Blob([await parser.getDependency("bufferView", image.bufferView)], { type: image.mimeType });
        } else if (typeof image.uri === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(image.uri)) {
          const [header, body] = image.uri.split(",", 2);
          const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
          blob = new Blob([bytes], { type: header.slice(5, header.indexOf(";")) });
        } else throw new Error("Model images must be embedded");
        const bitmap = await createImageBitmap(blob, { imageOrientation: "none", premultiplyAlpha: "none" });
        const texture = new THREE.Texture(bitmap);
        texture.needsUpdate = true;
        return texture;
      })());
      return cache.get(index).then((texture) => texture.clone());
    };
  } };
}

/** One scheduled draw per invalidation, with only a bounded factual-state sprite burst. */
export async function createSpace3D({ mount, onFallback, onProjection, onCamera }) {
  const canvas = document.createElement("canvas");
  canvas.className = "space-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("webgl2", { alpha: false, antialias: true });
  if (!context) throw new Error("WebGL2 is unavailable");
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.append(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.01, 1000);
  const loader = new GLTFLoader();
  loader.register(embeddedImages);
  const aborter = new AbortController();
  const textures = new Map(), models = new Map(), globalResources = new Set();
  let transientResources = [], contents = new THREE.Group();
  scene.add(contents);
  let state = null, generation = 0, dead = false, frame = 0, count = 0, signature = "";
  let readiness = Promise.resolve(), burstUntil = 0, spriteFrames = [], projection = { actors: [], cards: [] };
  let modelCount = 0, boxCount = 0;
  let cameraState = { yaw: 45, pitch: 60, zoom: 1 };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const anchors = { actors: [], cards: [] };
  const own = (resource) => { transientResources.push(resource); return resource; };
  const shared = (resource) => { globalResources.add(resource); return resource; };
  function instrumentation() {
    mount.dataset.renderCount = String(count); mount.dataset.pendingFrames = String(frame ? 1 : 0);
    mount.dataset.modelCount = String(modelCount); mount.dataset.boxCount = String(boxCount);
  }
  const request = () => { if (!dead && !frame) { frame = requestAnimationFrame(draw); instrumentation(); } };
  const fail = () => {
    if (dead) return;
    burstUntil = 0;
    if (frame) cancelAnimationFrame(frame);
    frame = 0; instrumentation();
    onFallback?.("3D is unavailable. Showing Room instead.");
  };
  const lost = (event) => { event.preventDefault(); fail(); };
  canvas.addEventListener("webglcontextlost", lost);

  async function bytes(url) {
    const response = await fetch(url, { signal: aborter.signal });
    if (!response.ok) throw new Error("A space asset could not load");
    return response;
  }
  function texture(url) {
    if (!textures.has(url)) textures.set(url, (async () => {
      const response = await bytes(url);
      const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: "flipY" });
      if (dead) { bitmap.close(); return null; }
      const value = shared(new THREE.Texture(bitmap));
      value.colorSpace = THREE.SRGBColorSpace;
      value.needsUpdate = true;
      return value;
    })().catch(() => null));
    return textures.get(url);
  }
  function model(name, pack) {
    const url = `/models/${pack.id}/${name}`;
    if (!models.has(url)) models.set(url, (async () => {
      const response = await bytes(url);
      const gltf = await loader.parseAsync(await response.arrayBuffer(), "");
      gltf.scene.traverse((node) => {
        if (node.geometry) shared(node.geometry);
        for (const material of node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : []) {
          shared(material);
          for (const value of Object.values(material)) if (value?.isTexture) shared(value);
        }
      });
      if (dead) { disposeShared(); return null; }
      return gltf.scene;
    })().catch(() => null));
    return models.get(url);
  }
  function disposeShared() {
    const bitmaps = new Set();
    for (const resource of globalResources) {
      if (resource.isTexture && resource.image?.close) bitmaps.add(resource.image);
      resource.dispose();
    }
    for (const bitmap of bitmaps) bitmap.close();
    globalResources.clear();
  }
  function reset() {
    scene.remove(contents);
    for (const resource of transientResources) resource.dispose();
    transientResources = [];
    contents = new THREE.Group(); scene.add(contents);
    spriteFrames = []; anchors.actors = []; anchors.cards = [];
    modelCount = 0; boxCount = 0;
  }
  function material(parameters) { return own(new THREE.MeshStandardMaterial(parameters)); }
  function box(width, height, depth, color, map) {
    const mesh = new THREE.Mesh(own(new THREE.BoxGeometry(width, height, depth)), material({ color, ...(map ? { map } : {}), roughness: 0.85 }));
    contents.add(mesh); return mesh;
  }
  function world(position, width, height, elevation = 0) {
    return new THREE.Vector3((position.x + width / 2 - state.layout.width / 2) / UNIT, elevation, (position.y + height / 2 - state.layout.height / 2) / UNIT);
  }
  function furniture(name, location, dimensions, resources) {
    const asset = resources.models.get(name);
    if (asset) {
      const group = asset.clone(true);
      const bounds = new THREE.Box3().setFromObject(group), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
      const scale = Math.min(dimensions[0] / (size.x || 1), dimensions[1] / (size.y || 1), dimensions[2] / (size.z || 1));
      const wrapper = new THREE.Group();
      group.position.set(-center.x, -bounds.min.y, -center.z); group.scale.setScalar(1);
      wrapper.add(group); wrapper.scale.setScalar(scale); wrapper.position.copy(location);
      contents.add(wrapper); modelCount += 1;
    } else {
      const mesh = box(...dimensions, 0x9f8064, resources.images.get(name));
      mesh.position.copy(location); mesh.position.y += dimensions[1] / 2; boxCount += 1;
    }
  }
  function rebuild(resources) {
    reset();
    const rgb = String(state.theme).match(/[0-9.]+/g)?.slice(0, 3).map(Number);
    const dark = state.theme === "dark" || (rgb?.length === 3 && rgb.reduce((sum, n) => sum + n, 0) > 420);
    scene.background = new THREE.Color(dark ? 0x20242b : 0xe9ece9);
    contents.add(new THREE.HemisphereLight(0xffffff, dark ? 0x7b8296 : 0xa39a87, 2.4));
    const light = new THREE.DirectionalLight(0xffffff, 2.5); light.position.set(-4, 12, 7); contents.add(light);
    const width = state.layout.width / UNIT, depth = state.layout.height / UNIT;
    const floorMap = resources.images.get("floor")?.clone();
    if (floorMap) {
      own(floorMap); floorMap.wrapS = floorMap.wrapT = THREE.RepeatWrapping;
      floorMap.repeat.set(state.layout.width / (state.pack.tile?.[0] || 64), state.layout.height / (state.pack.tile?.[1] || 64));
    }
    const floor = new THREE.Mesh(own(new THREE.PlaneGeometry(width + 0.8, depth + 0.8)), material({ color: dark ? 0x707a79 : 0xd4d5c1, ...(floorMap ? { map: floorMap } : {}), side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.025; contents.add(floor);
    const wallMap = resources.images.get("wall");
    const wall = box(width + 0.8, 1.3, 0.08, dark ? 0x8a9397 : 0xe0ddd0, wallMap); wall.position.set(0, 0.65, -depth / 2 - 0.4);
    for (const zone of state.model.zones) {
      const p = state.layout.zones.get(zone.id);
      if (!p) continue;
      const name = zone.kind === "done" ? "shelf" : "board";
      furniture(name, world(p, 234, 0), [1.8, 1.05, 0.35], resources);
    }
    for (const actor of state.model.actors) {
      const p = state.layout.actors.get(actor.id), metric = state.actors.find((a) => a.id === actor.id);
      if (!p || !metric) continue;
      const at = world(p, metric.width, metric.height);
      furniture("desk", at, [1.25, 0.65, 0.7], resources);
      const pet = state.pets.find((item) => item.id === actor.pet) ?? (state.pets.length ? state.pets[hash(actor.id) % state.pets.length] : null);
      const sheet = pet && resources.pets.get(pet.id);
      if (sheet) {
        const map = own(sheet.clone());
        const [row, frames] = rows[actor.stale ? "idle" : actor.state] ?? rows.idle;
        map.repeat.set(1 / 8, 1 / 11); map.offset.set(0, 1 - (row + 1) / 11);
        map.magFilter = THREE.NearestFilter; map.minFilter = THREE.LinearFilter;
        const sprite = new THREE.Sprite(own(new THREE.SpriteMaterial({ map, transparent: true, alphaTest: 0.02, depthWrite: false })));
        sprite.position.copy(at); sprite.position.y = 1.15; sprite.scale.set(0.9, 0.975, 1);
        const backing = new THREE.Sprite(own(new THREE.SpriteMaterial({ color: 0xe7ecf4, depthWrite: false })));
        backing.position.copy(sprite.position); backing.scale.set(0.98, 1.055, 1);
        backing.renderOrder = 1; sprite.renderOrder = 2;
        contents.add(backing, sprite);
        if (!actor.stale && actor.state !== "idle" && actor.state !== "away") spriteFrames.push({ map, frames, row });
        anchors.actors.push({ id: actor.id, position: sprite.position });
      } else {
        const token = box(0.5, 0.55, 0.35, actor.state === "blocked" ? 0xc9534c : 0x668cba);
        token.position.copy(at); token.position.y = 1.05;
        anchors.actors.push({ id: actor.id, position: token.position });
      }
    }
    for (const card of state.model.cards) {
      const p = state.layout.cards.get(card.id), metric = state.cards.find((item) => item.id === card.id);
      if (!p || !metric) continue;
      const mesh = box(Math.max(0.6, metric.width / UNIT * 0.75), 0.12, Math.max(0.3, metric.height / UNIT * 0.7), card.tone === "err" ? 0xb95d56 : card.tone === "ok" ? 0x6d967b : card.tone === "warn" ? 0xe8c981 : 0xd4cdbb);
      mesh.position.copy(world(p, metric.width, metric.height, 0.24));
      anchors.cards.push({ id: card.id, position: mesh.position });
    }
    // Message lifetimes belong to the existing DOM renderer; never leave a stale message in a frozen canvas.
    for (const link of state.model.links.filter((item) => item.kind !== "message")) {
      const from = anchors.actors.find((item) => item.id === link.from), to = anchors.actors.find((item) => item.id === link.to);
      if (!from || !to) continue;
      const points = [from.position.clone(), to.position.clone()];
      const line = new THREE.Line(own(new THREE.BufferGeometry().setFromPoints(points)), own(new THREE.LineBasicMaterial({ color: link.kind === "message" ? 0xb78c36 : 0x7793a6, transparent: true, opacity: 0.65 })));
      contents.add(line);
    }
    aim();
  }
  function aim() {
    if (!state) return;
    const width = Math.max(1, state.width), height = Math.max(1, state.height);
    renderer.setSize(width, height, false);
    const aspect = width / height;
    // Fit the entire layout at every yaw; the DOM overlay and canvas share this viewport.
    const radius = Math.hypot(state.layout.width, state.layout.height) / UNIT / 2 + 1.4;
    const span = radius / Math.max(0.4, cameraState.zoom);
    camera.left = -span * Math.max(1, aspect); camera.right = span * Math.max(1, aspect);
    camera.top = span * Math.max(1, 1 / aspect); camera.bottom = -camera.top;
    const yaw = radians(cameraState.yaw), pitch = radians(cameraState.pitch), distance = radius * 3 + 10;
    camera.position.set(Math.sin(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance, Math.cos(yaw) * Math.cos(pitch) * distance);
    camera.lookAt(0, 0, 0); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  }
  function draw(now) {
    frame = 0;
    if (dead || !state || context.isContextLost()) { instrumentation(); return; }
    const animating = now < burstUntil && !reduced.matches;
    for (const item of spriteFrames) item.map.offset.x = (animating ? Math.floor(now / 150) % item.frames : 0) / 8;
    try { renderer.render(scene, camera); } catch { fail(); return; }
    count += 1; instrumentation();
    const point = (entry) => {
      const p = entry.position.clone().project(camera);
      return { id: entry.id, x: (p.x + 1) * state.width / 2, y: (1 - p.y) * state.height / 2, depth: p.z };
    };
    projection = { actors: anchors.actors.map(point), cards: anchors.cards.map(point) };
    onProjection?.(projection);
    if (animating) request();
  }
  async function update(next) {
    const { sampledAt, samples, ...facts } = next.model;
    const nextSignature = JSON.stringify([facts, [...next.layout.actors], [...next.layout.cards], [...next.layout.zones], next.layout.width, next.layout.height, next.pack, next.pets, next.actors.map(({ id, width, height }) => [id, width, height]), next.cards.map(({ id, width, height }) => [id, width, height]), next.width, next.height, next.theme]);
    state = next;
    if (nextSignature === signature) return readiness;
    signature = nextSignature;
    const turn = ++generation;
    const pack = state.pack;
    const images = new Map(), pets = new Map(), templates = new Map();
    const jobs = [];
    for (const name of (pack?.images ?? []).filter((name) => ["floor", "wall", "desk", "shelf", "board"].includes(name))) jobs.push(texture(`/assets/${pack.id}/${name}`).then((value) => { if (value) images.set(name, value); }));
    for (const pet of state.pets) jobs.push(texture(`/pets/${pet.id}/sheet`).then((value) => { if (value) pets.set(pet.id, value); }));
    for (const name of (pack?.models ?? []).filter((name) => ["desk", "shelf", "board"].includes(name))) jobs.push(model(name, pack).then((value) => { if (value) templates.set(name, value); }));
    readiness = Promise.all(jobs).then(() => {
      if (dead || turn !== generation) return;
      rebuild({ images, pets, models: templates });
      burstUntil = reduced.matches || state.layout.settle ? 0 : performance.now() + 800;
      request();
    }).catch(() => { if (!dead && turn === generation) fail(); });
    return readiness;
  }
  function setCamera(next) {
    const value = { yaw: Number.isFinite(next.yaw) ? next.yaw : cameraState.yaw, pitch: Number.isFinite(next.pitch) ? Math.max(20, Math.min(80, next.pitch)) : cameraState.pitch, zoom: Number.isFinite(next.zoom) ? Math.max(0.4, Math.min(2, next.zoom)) : cameraState.zoom };
    if (value.yaw === cameraState.yaw && value.pitch === cameraState.pitch && value.zoom === cameraState.zoom) return;
    cameraState = value;
    aim(); request();
  }
  let drag = null;
  const pointerDown = (event) => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: cameraState.yaw, pitch: cameraState.pitch };
    canvas.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    setCamera({ ...cameraState, yaw: drag.yaw - (event.clientX - drag.x) * 0.35, pitch: drag.pitch + (event.clientY - drag.y) * 0.2 });
    onCamera?.({ ...cameraState });
  };
  const pointerEnd = (event) => { if (drag?.id === event.pointerId) drag = null; };
  canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerEnd); canvas.addEventListener("pointercancel", pointerEnd);
  const motionChanged = () => { if (reduced.matches) { burstUntil = 0; request(); } };
  reduced.addEventListener("change", motionChanged);
  return { update, setCamera,
    get renderCount() { return count; }, get ready() { return readiness; }, get pendingFrames() { return frame ? 1 : 0; },
    get modelCount() { return modelCount; }, get boxCount() { return boxCount; }, get projection() { return projection; },
    destroy() {
      if (dead) return;
      dead = true; generation += 1; aborter.abort();
      if (frame) cancelAnimationFrame(frame);
      frame = 0; instrumentation();
      canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerEnd); canvas.removeEventListener("pointercancel", pointerEnd);
      canvas.removeEventListener("webglcontextlost", lost); reduced.removeEventListener("change", motionChanged);
      for (const resource of transientResources) resource.dispose(); transientResources = [];
      disposeShared(); renderer.dispose(); canvas.remove();
    }
  };
}
