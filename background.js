/**
 * background.js - service worker / orchestrator.
 *
 * Every listener is registered synchronously at the top level so the worker can
 * be torn down when idle and revived by an incoming event (MV3 requirement).
 * No meaningful state lives in module globals; anything that must survive a
 * restart goes into chrome.storage.
 */

const SETTINGS_DEFAULTS = {
  autoCopy: true, // copy as soon as the drag ends
  closeAfterCopy: true, // dismiss the overlay after a successful copy
  saveFile: false, // also download a .png
};

const HISTORY_KEY = "snipHistory";
const HISTORY_MAX_ITEMS = 12;
const HISTORY_MAX_BYTES = 7 * 1024 * 1024; // stay well inside the storage.local quota

const OFFSCREEN_URL = "offscreen.html";

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "start-snip") return;
  // The keyboard shortcut is a user gesture, so activeTab is granted here.
  resolveTab(tab)
    .then((t) => beginSnip(t, "toggle"))
    .catch(reportFailure);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg && msg.type) {
    case "BEGIN_SNIP":
      resolveTab(null)
        .then((t) => beginSnip(t, "start"))
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: describe(err) }));
      return true;

    case "COPY_IMAGE":
      copyViaOffscreen(msg.dataUrl)
        .then((ok) => sendResponse({ ok }))
        .catch((err) => sendResponse({ ok: false, error: describe(err) }));
      return true;

    case "ADD_HISTORY":
      addHistory(msg.item)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: describe(err) }));
      return true;

    case "CLOSE_SELF":
      if (sender.tab && sender.tab.windowId != null) {
        chrome.windows.remove(sender.tab.windowId).catch(() => {});
      }
      return false;

    default:
      return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  migrateSettings().catch(() => {});
});

/* ------------------------------------------------------------------ *
 * Snip orchestration
 * ------------------------------------------------------------------ */

async function resolveTab(tab) {
  if (tab && tab.id != null && tab.id !== chrome.tabs.TAB_ID_NONE) return tab;
  const [active] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!active || active.id == null) throw new Error("No active tab to snip.");
  return active;
}

/**
 * Capture happens FIRST, before any UI exists. That is what makes this both
 * fast and correct:
 *   - one captureVisibleTab call per snip (the API is throttled to 2/second),
 *   - the overlay can never leak into the screenshot, so there is no
 *     hide / wait / capture / restore round trip,
 *   - every later crop is pure canvas work, so it feels instant.
 * Capture and script injection are kicked off together rather than in series.
 */
async function beginSnip(tab, intent) {
  const tabId = tab.id;

  const capturing = chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  const injecting = chrome.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      files: ["snip-ui.js", "content.js"],
    })
    .then(
      () => true,
      () => false // restricted page: chrome://, Web Store, view-source, ...
    );

  let dataUrl;
  try {
    dataUrl = await capturing;
  } catch (err) {
    await injecting; // don't leave a dangling rejection behind
    throw new Error(captureHint(err, tab));
  }
  const injected = await injecting;

  // Why the overlay could not run, so the fallback window can say so.
  let reason = "restricted";
  if (injected) {
    reason = "blocked";
    try {
      const res = await chrome.tabs.sendMessage(tabId, {
        type: "SNIP_START",
        dataUrl,
        intent,
      });
      if (res && res.started) return { ok: true, mode: "overlay" };
      if (res && res.reason) reason = res.reason;
    } catch {
      // Receiver gone, or the frame refuses messages - fall through.
    }
  }

  // Fallback for pages where an in-page overlay cannot work. Chrome's PDF
  // viewer is the main one: a content script does attach to the wrapper
  // document, but the <embed> swallows every pointer event, so the overlay
  // would look correct and never respond. Snipping in our own window always
  // works, on every URL.
  await openSnipWindow(dataUrl, reason);
  return { ok: true, mode: "window", reason };
}

async function openSnipWindow(dataUrl, reason) {
  const key = `pending:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  // storage.session is memory-backed and not exposed to content scripts, which
  // makes it the right place to hand a multi-megabyte data URL to our own page.
  await chrome.storage.session.set({ [key]: dataUrl });

  const url = chrome.runtime.getURL(
    `editor.html?k=${encodeURIComponent(key)}&why=${encodeURIComponent(
      reason || ""
    )}`
  );
  try {
    await chrome.windows.create({ url, type: "popup", state: "maximized" });
  } catch {
    await chrome.windows.create({
      url,
      type: "popup",
      width: 1200,
      height: 800,
    });
  }
}

function captureHint(err, tab) {
  const msg = describe(err);
  // activeTab does not cover local files; Chrome requires the per-extension
  // file-access opt-in. Say so instead of reporting a generic denial.
  if (tab && typeof tab.url === "string" && tab.url.startsWith("file:")) {
    return 'To snip local files, turn on "Allow access to file URLs" for this extension on chrome://extensions.';
  }
  if (/activeTab|permission/i.test(msg)) {
    return "Chrome did not grant access to this tab. Click the toolbar icon or press the shortcut again.";
  }
  if (/quota/i.test(msg)) {
    return "Chrome is rate-limiting screenshots. Try again in a second.";
  }
  return `Could not capture this tab: ${msg}`;
}

function reportFailure(err) {
  // The shortcut path has no popup to render an error into; the console is the
  // only honest place to put it.
  console.error("[Snip In Browser]", describe(err));
}

function describe(err) {
  if (!err) return "Unknown error";
  return err.message || String(err);
}

/* ------------------------------------------------------------------ *
 * Clipboard fallback (offscreen document)
 * ------------------------------------------------------------------ */

/**
 * Used only when navigator.clipboard is unavailable in the calling context.
 * The common case is an http:// page: the Clipboard API is withheld there
 * because the origin is not a secure context, which is why v1 silently failed
 * on plain-HTTP sites.
 */
async function copyViaOffscreen(dataUrl) {
  if (!dataUrl) return false;
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OFFSCREEN_COPY_IMAGE",
    dataUrl,
  });
  return !!(res && res.ok);
}

let offscreenPending = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) return;

  // Only one offscreen document may exist at a time and concurrent
  // createDocument calls race, so collapse them onto one promise.
  if (!offscreenPending) {
    offscreenPending = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["CLIPBOARD"],
        justification:
          "Write a cropped screenshot to the clipboard when the page context cannot.",
      })
      .catch((err) => {
        if (!/single offscreen/i.test(describe(err))) throw err;
      })
      .finally(() => {
        offscreenPending = null;
      });
  }
  await offscreenPending;
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

async function addHistory(item) {
  if (!item || !item.full) return;
  const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(
    HISTORY_KEY
  );
  const next = [item, ...history].slice(0, HISTORY_MAX_ITEMS);

  // Evict oldest entries until the payload fits comfortably inside quota.
  let bytes = next.reduce((sum, it) => sum + itemBytes(it), 0);
  while (next.length > 1 && bytes > HISTORY_MAX_BYTES) {
    bytes -= itemBytes(next.pop());
  }

  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
  } catch {
    // Last resort: keep the newest snip rather than losing the write entirely.
    await chrome.storage.local.set({ [HISTORY_KEY]: [item] });
  }
}

function itemBytes(it) {
  return (it.full ? it.full.length : 0) + (it.thumb ? it.thumb.length : 0);
}

/* ------------------------------------------------------------------ *
 * Settings migration (v1.x -> v2)
 * ------------------------------------------------------------------ */

async function migrateSettings() {
  const stored = await chrome.storage.sync.get(null);
  if ("autoCopy" in stored) return; // already on the v2 shape

  const patch = { ...SETTINGS_DEFAULTS };
  if ("autoCopyOnMouseup" in stored) {
    // v1 always auto-copied; the flag really controlled "close afterwards".
    patch.autoCopy = true;
    patch.closeAfterCopy = !!stored.autoCopyOnMouseup;
  }
  await chrome.storage.sync.set(patch);
  await chrome.storage.sync.remove("autoCopyOnMouseup");
}
