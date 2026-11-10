// Probes that rewrite a snapshot body act as legacy fixture providers: an upstream
// hash/sample time no longer describes their synthetic scene. Request the full
// source and remove that metadata, while protocol behavior is tested separately.
const metadata = new Set(["x-acon-version", "x-acon-cache", "x-acon-cache-age-ms", "x-acon-sampled-at", "content-length"]);
export async function fetchFullSnapshot(route) {
  const { known: _known, ...input } = route.request().postDataJSON();
  return route.fetch({ postData: JSON.stringify(input) });
}
export async function fulfillSnapshotFixture(route, response, body) {
  const headers = Object.fromEntries(Object.entries(response.headers()).filter(([name]) => !metadata.has(name.toLowerCase())));
  await route.fulfill({ response, headers, json: body });
}
