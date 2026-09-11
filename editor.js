/**
 * editor.js - drives the standalone snip window.
 *
 * The service worker opens this page whenever an in-page overlay is impossible
 * (Chrome's PDF viewer, chrome:// pages, the Web Store, view-source, ...) and
 * leaves the screenshot in chrome.storage.session for us to pick up.
 *
 * Selection behaviour is identical to the in-page overlay because both run the
 * same snip-ui.js engine.
 */

const SETTINGS_DEFAULTS = {
  autoCopy: true,
  closeAfterCopy: true,
  saveFile: false,
};

const stage = document.getElementById("stage");
const canvas = document.getElementById("canvas");
const errorEl = document.getElementById("error");
const toastEl = document.getElementById("toast");

document.getElementById("close").addEventListener("click", closeWindow);

init().catch((err) => fail(err && err.message ? err.message : String(err)));

// Say which of the several "can't run here" cases this actually was, rather
// than a vague "this page".
const NOTES = {
  pdf: "Chrome’s PDF viewer swallows clicks, so the overlay can’t run on it — drag on this snapshot instead.",
  restricted:
    "Chrome doesn’t let extensions draw on this page, so here’s a snapshot of it — drag to select.",
  "overlay-misplaced":
    "This page’s styling would put the overlay in the wrong place, so here’s a snapshot of it — drag to select.",
  blocked:
    "The overlay couldn’t start on this page, so here’s a snapshot of it — drag to select.",
};

async function init() {
  const params = new URLSearchParams(location.search);
  const note = NOTES[params.get("why")];
  if (note) document.getElementById("note").textContent = note;

  const key = params.get("k");
  if (!key) throw new Error("No screenshot was handed to this window.");

  const stored = await chrome.storage.session.get(key);

  const dataUrl = stored[key];
  // One-shot handoff: drop it as soon as we have it so a multi-megabyte data
  // URL is not left sitting in session storage.
  chrome.storage.session.remove(key).catch(() => {});
  if (!dataUrl) throw new Error("That screenshot has already been used.");

  const [image, settings] = await Promise.all([
    decode(dataUrl),
    loadSettings(),
  ]);

  layout(image, settings);

  // The window is created maximized, but the page can start loading before
  // that takes effect, and the user may resize afterwards. Re-fit rather than
  // leave the screenshot rendered into a corner of a large window. Rebuilding
  // is what keeps the selection coordinates honest against the new stage size.
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layout(image, settings), 150);
  });
}

let session = null;

function layout(image, settings) {
  const fit = fitToCanvas(image);
  if (
    session &&
    fit.width === parseFloat(stage.style.width) &&
    fit.height === parseFloat(stage.style.height)
  ) {
    return; // nothing actually changed
  }

  if (session) session.destroy();
  stage.replaceChildren();
  stage.style.width = `${fit.width}px`;
  stage.style.height = `${fit.height}px`;

  session = window.__SnipUI.create({
    root: stage,
    image,
    width: fit.width,
    height: fit.height,
    settings,
    blockScroll: true,
    closeOnResize: false, // handled here instead, by re-fitting
    onFlash: toast,
    onClose: closeWindow,
  });
}

/**
 * Largest 1:1-or-smaller rectangle that fits the available area. Never upscale:
 * a blown-up screenshot would make the user aim at soft pixels.
 */
function fitToCanvas(image) {
  const styles = getComputedStyle(canvas);
  const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  const availW = Math.max(1, canvas.clientWidth - padX);
  const availH = Math.max(1, canvas.clientHeight - padY);

  const ratio = Math.min(
    availW / image.naturalWidth,
    availH / image.naturalHeight,
    1
  );
  return {
    width: Math.max(1, Math.round(image.naturalWidth * ratio)),
    height: Math.max(1, Math.round(image.naturalHeight * ratio)),
  };
}

function decode(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Screenshot could not be decoded."));
    img.src = dataUrl;
  });
}

async function loadSettings() {
  try {
    return await chrome.storage.sync.get(SETTINGS_DEFAULTS);
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

let toastTimer = 0;

function toast(message, tone) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.dataset.tone = tone === "warn" ? "warn" : "ok";
  toastEl.hidden = false;
  requestAnimationFrame(() => {
    toastEl.dataset.show = "1";
  });
  toastTimer = setTimeout(
    () => {
      toastEl.dataset.show = "0";
    },
    tone === "warn" ? 2600 : 1300
  );
}

function fail(message) {
  stage.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function closeWindow() {
  // Ask the service worker to remove our window; window.close() is unreliable
  // for pages the script did not open itself.
  chrome.runtime.sendMessage({ type: "CLOSE_SELF" }).catch(() => window.close());
  setTimeout(() => window.close(), 250);
}

// Esc always closes, even before the engine has mounted its own handler.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeWindow();
});
