// Snapshot transport metadata is separate from every producer's open-record body.
const SNAPSHOT_HEADERS = ["x-acon-version", "x-acon-cache", "x-acon-cache-age-ms", "x-acon-sampled-at"];
export function snapshotHeaders(response) {
  return Object.fromEntries(SNAPSHOT_HEADERS.flatMap((name) => {
    const value = response.headers?.get?.(name);
    return typeof value === "string" ? [[name, value]] : [];
  }));
}
