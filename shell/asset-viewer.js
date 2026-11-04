// Opaque sandbox: only the parent may supply bounded, allowlisted attachment bytes.
const types = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv']);
let objectUrl;
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.kind !== 'acon-asset') return;
  const { mime, bytes } = event.data;
  if (!types.has(mime) || !(bytes instanceof ArrayBuffer) || bytes.byteLength > 32 * 1024 * 1024) return;
  const root = document.getElementById('asset');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  if (mime.startsWith('text/')) {
    const pre = document.createElement('pre');
    pre.textContent = new TextDecoder().decode(bytes);
    root.replaceChildren(pre);
  } else {
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const child = document.createElement(mime === 'application/pdf' ? 'iframe' : 'img');
    child.src = objectUrl;
    if (child.tagName === 'IMG') child.alt = 'Attachment';
    else child.title = 'PDF attachment';
    root.replaceChildren(child);
  }
});
parent.postMessage({ kind: 'acon-asset-ready' }, location.origin);
