// Code stringified into the fixture panel module; it has no top-level DOM access.
export function workerEntry(scope) {
  scope.addEventListener("message", (event) => {
    if (!(event.data instanceof Float32Array)) return;
    const values = event.data;
    values[0] += 1;
    scope.postMessage(values, [values.buffer]);
  });
}

export function installWorkerProbe(host, mount) {
  mount.addEventListener("ui-worker-probe", async () => {
    let worker, blobUrl;
    try {
      if (typeof host.worker !== "function") throw new Error("host.worker is missing");
      worker = await host.worker();
      const values = new Float32Array([1, 2, 3]);
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker transfer timed out")), 5000);
        worker.addEventListener("message", (event) => { clearTimeout(timer); resolve(event.data); }, { once: true });
      });
      worker.postMessage(values, [values.buffer]);
      if (values.byteLength !== 0) throw new Error("input buffer was not transferred");
      const returned = await reply;
      if (!(returned instanceof Float32Array) || returned.length !== 3 || returned[0] !== 2 || returned[1] !== 2 || returned[2] !== 3) throw new Error("worker transfer returned the wrong values");
      blobUrl = URL.createObjectURL(new Blob(["postMessage('unexpected')"], { type: "text/javascript" }));
      const blocked = await new Promise((resolve) => {
        let bad;
        try {
          bad = new Worker(blobUrl);
          bad.onmessage = () => { bad.terminate(); resolve(false); };
          bad.onerror = (event) => { event.preventDefault(); bad.terminate(); resolve(true); };
          setTimeout(() => { bad.terminate(); resolve(false); }, 3000);
        } catch { bad?.terminate(); resolve(true); }
      });
      if (!blocked) throw new Error("blob worker was not blocked");
      mount.dataset.workerProbe = "pass";
    } catch (error) {
      mount.dataset.workerProbe = "fail";
      mount.dataset.workerError = String(error?.message ?? error).split("\n")[0].slice(0, 200);
    } finally { worker?.terminate(); if (blobUrl) URL.revokeObjectURL(blobUrl); }
  });
}
