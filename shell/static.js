// H2 transport. Credentials live only in this tab; the static host serves no node data.
const NODE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_ID = /^[a-z][a-z0-9-]{1,15}$/;
const loopback = (host) => host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);

export function createStaticTransport(config, onStatus = () => {}) {
  if (config?.api !== 1 || !Array.isArray(config.nodes) || !config.nodes.length || config.nodes.length > 32) throw new Error('Invalid static config; rebuild with acon build --static --nodes id=https://node.example');
  const ids = new Set();
  const nodes = config.nodes.map((input) => {
    let url;
    try { url = new URL(input?.url); } catch { throw new Error("Invalid node URL in config.json; rebuild with acon build --static --nodes id=https://node.example"); }
    if (!NODE_ID.test(input.id) || ids.has(input.id) || url.origin !== input.url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname)))) throw new Error('Invalid node id or origin in config.json; rebuild with unique ids and exact HTTPS origins');
    ids.add(input.id);
    const key = `acon.auth:${input.id}:${url.origin}`;
    let token = '';
    try { token = sessionStorage.getItem(key) ?? ''; } catch { /* this tab may disallow storage */ }
    return { id: input.id, url: url.origin, key, token, status: 'connecting', detail: 'Connecting to node', grant: '', grantUntil: 0, data: null, busy: null };
  });
  const notify = (node, status, detail) => { node.status = status; node.detail = detail; onStatus(); };
  const headersFor = (node, json = true) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), ...(node.token ? { Authorization: `Bearer ${node.token}` } : {}) });
  const failed = async (node) => {
    // A failed CORS fetch and a stopped node look identical to JavaScript. An opaque,
    // bounded health probe establishes reachability without reading cross-origin data.
    try {
      await fetch(`${node.url}/healthz`, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(3000) });
      notify(node, 'refused (origin)', 'Node reachable but browser access refused; add this shell origin to acon serve --origin and check the Access CORS settings.');
    } catch { notify(node, 'offline', 'Node is unreachable; start acon serve and check the node URL and network.'); }
    return { status: 0, data: { ok: false, error: node.detail } };
  };
  const request = async (node, path, body) => {
    let response;
    try {
      response = await fetch(`${node.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: headersFor(node, body !== undefined), ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000), redirect: 'error' });
    } catch { return failed(node); }
    let data = null;
    try { data = await response.json(); } catch { /* named status below, no provider body shown */ }
    if (response.status === 401 || response.status === 403) {
      node.grant = '';
      notify(node, 'unauthorized', 'Authentication refused; enter this node\'s bearer token or sign in to its Access application, then reconnect.');
    } else if (response.ok && data && typeof data === "object" && !Array.isArray(data)) notify(node, 'online', 'Connected');
    else notify(node, "offline", `Node response was unavailable or invalid (HTTP ${response.status}); check acon serve and its System log.`);
    return { status: response.status, data: data ?? { ok: false, error: `Node answered HTTP ${response.status}; check its System log.` } };
  };
  const connect = async (node) => {
    if (!node.grant || Date.now() >= node.grantUntil) {
      const session = await request(node, '/session', { resources: true });
      if (session.status !== 200 || !/^[0-9a-f]{64}$/.test(session.data.resourceToken ?? '')) return null;
      node.grant = session.data.resourceToken;
      node.grantUntil = Date.now() + Math.min(Number(session.data.expiresIn) || 0, 3600000) - 10000;
    }
    const result = await request(node, '/tools', {});
    node.data = result.status === 200 ? result.data : null;
    return node.data;
  };
  const owner = (key) => nodes.find((node) => key.startsWith(`${node.id}:`));
  const resolve = (path, refs = new Map()) => {
    const match = /^\/p\/([^/]+)\/(.*)$/.exec(path);
    if (!match) return null;
    const node = owner(match[1]);
    if (!node) return null;
    const raw = match[1].slice(node.id.length + 1);
    if (!TOOL_ID.test(raw)) return null;
    const ref = refs.get(match[1]) ?? raw;
    if (!new RegExp(`^${raw}(?:@[0-9a-f]{12})?$`).test(ref)) return null;
    return { node, path: `/p/${ref}/${match[2]}` };
  };
  return {
    nodes,
    async tools() {
      // One bounded refresh per node, with no nested retry loop or repeated auth prompt.
      await Promise.all(nodes.map((node) => node.busy ??= connect(node).finally(() => { node.busy = null; })));
      const tools = nodes.flatMap((node) => (node.data?.tools ?? []).filter((tool) => TOOL_ID.test(tool?.tool)).map((tool) => ({ ...tool, tool: `${node.id}:${tool.tool}`, rawTool: tool.tool, node: node.id, title: `${node.id}: ${tool.title ?? tool.tool}`, readOnly: node.data.readOnly === true, ...(node.status === 'online' ? {} : { status: 'offline', reason: node.detail }) })));
      return { status: 200, data: { tools, pets: [], assetPacks: [], node: { id: 'static', version: 'H2' }, errors: [], readOnly: false } };
    },
    async post(path, body, refs) {
      if (path === '/tools') return this.tools();
      if (path === '/ping') return { status: 200, data: { ok: true } };
      const route = resolve(path, refs);
      if (!route) return { status: 404, data: { ok: false, error: 'Unknown node/tool route; reload the static console.' } };
      return request(route.node, route.path, body);
    },
    resource(path, refs) {
      const route = resolve(path, refs);
      if (!route) return path;
      const url = new URL(route.path, route.node.url);
      url.searchParams.set('acon_resource', route.node.grant);
      return url.href;
    },
    async loadStyle(path, refs) {
      const route = resolve(path, refs);
      if (!route) throw new Error('Unknown plugin stylesheet node; reload the console.');
      const response = await fetch(this.resource(path, refs), { headers: headersFor(route.node, false), credentials: 'include', signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) throw new Error('Plugin stylesheet could not load; check this node\'s authentication in System.');
      // Constructed sheets preserve style-src self: no remote link or inline style element.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(await response.text());
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    },
    setToken(id, token) {
      const node = nodes.find((item) => item.id === id);
      if (!node) return;
      node.token = token.trim(); node.grant = ''; node.data = null;
      try { if (node.token) sessionStorage.setItem(node.key, node.token); else sessionStorage.removeItem(node.key); } catch { /* memory-only tab */ }
      notify(node, 'connecting', 'Reconnecting');
    },
  };
}
