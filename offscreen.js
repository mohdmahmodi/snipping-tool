/**
 * offscreen.js - clipboard of last resort.
 *
 * Reached only when the calling context has no usable Clipboard API. The most
 * common case is an http:// page, where navigator.clipboard is withheld
 * because the origin is not a secure context.
 *
 * navigator.clipboard is not an option here either: an offscreen document is
 * never focused, and the async Clipboard API rejects on unfocused documents.
 * Selecting an <img> and running execCommand("copy") has no such requirement,
 * and Chrome puts a real bitmap on the clipboard rather than markup.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return undefined;
  if (msg.type !== "OFFSCREEN_COPY_IMAGE") return undefined;

  copyImage(msg.dataUrl)
    .then((ok) => sendResponse({ ok }))
    .catch(() => sendResponse({ ok: false }));
  return true; // async response
});

async function copyImage(dataUrl) {
  const sink = document.getElementById("sink");
  sink.replaceChildren();

  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  sink.appendChild(img);

  const range = document.createRange();
  range.selectNode(img);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    selection.removeAllRanges();
    sink.replaceChildren();
  }
  return ok;
}
