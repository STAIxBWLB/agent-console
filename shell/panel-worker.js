// Same-origin shim: import only a panel module, once. The URL (and any resource grant) never enters the worker URL.
let loaded = false;
self.addEventListener("message", async (event) => {
  if (event.data?.acon !== "load") return;
  if (loaded) { self.postMessage({ acon: "error", error: "panel worker already loaded; create a new worker instead" }); return; }
  loaded = true;
  try {
    let url;
    try { url = new URL(event.data.url, self.location.href); }
    catch { throw new Error("invalid panel module path; reload the page and use host.worker()"); }
    if (!/^https?:$/.test(url.protocol) || !/^\/p\/[a-z][a-z0-9-]{1,15}(?:@[0-9a-f]{12})?\/panel\.js$/.test(url.pathname) || url.username || url.password || url.hash) {
      throw new Error("invalid panel module path; reload the page and use host.worker()");
    }
    let module;
    try { module = await import(url.href); }
    catch { throw new Error("panel worker module could not load; reload the page and check the node connection"); }
    if (typeof module.worker !== "function") throw new Error("panel module has no worker export; add worker(scope) or use the main-thread fallback");
    try { await module.worker(self); }
    catch { throw new Error("panel worker initialization failed; check the worker export and reload the page"); }
    self.postMessage({ acon: "ready" });
  } catch (error) {
    self.postMessage({ acon: "error", error: error instanceof Error ? error.message : "panel worker failed; reload the page and retry" });
  }
});
