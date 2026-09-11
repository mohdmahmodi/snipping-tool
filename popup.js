/**
 * popup.js - toolbar popup: start a snip, tune behavior, reuse recent snips.
 */

const SETTINGS = {
  "opt-autocopy": "autoCopy",
  "opt-close": "closeAfterCopy",
  "opt-save": "saveFile",
};
const SETTINGS_DEFAULTS = {
  autoCopy: true,
  closeAfterCopy: true,
  saveFile: false,
};

const HISTORY_KEY = "snipHistory";

const $ = (id) => document.getElementById(id);
const gridEl = $("grid");
const alertEl = $("alert");
const snackEl = $("snack");
const clearBtn = $("clear");

const ICONS = {
  save: '<path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 12h10l1-12"/>',
};

init();

function init() {
  $("start").addEventListener("click", startSnip);
  $("shortcut").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    window.close();
  });
  clearBtn.addEventListener("click", clearHistory);

  showShortcut();
  bindSettings();
  renderHistory();

  // Keep the list live if a snip lands while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[HISTORY_KEY]) {
      renderHistory(changes[HISTORY_KEY].newValue || []);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

async function startSnip() {
  const btn = $("start");
  btn.disabled = true;
  alertEl.hidden = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: "BEGIN_SNIP" });
    if (!res || !res.ok) throw new Error((res && res.error) || "Snip failed.");
    window.close();
  } catch (err) {
    // Stay open and say what happened, rather than v1's silent close.
    alertEl.textContent = err && err.message ? err.message : String(err);
    alertEl.hidden = false;
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Shortcut
 * ------------------------------------------------------------------ */

async function showShortcut() {
  const label = $("shortcut-keys");
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === "start-snip");
    // Chrome already renders this per platform (⌘⇧S on macOS, Ctrl+Shift+S
    // elsewhere) and reflects any key the user rebound.
    label.textContent = cmd && cmd.shortcut ? cmd.shortcut : "Set shortcut";
  } catch {
    label.textContent = "Set shortcut";
  }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

async function bindSettings() {
  let stored;
  try {
    stored = await chrome.storage.sync.get(SETTINGS_DEFAULTS);
  } catch {
    stored = { ...SETTINGS_DEFAULTS };
  }

  for (const [id, key] of Object.entries(SETTINGS)) {
    const input = $(id);
    input.checked = !!stored[key];
    input.addEventListener("change", () => {
      chrome.storage.sync.set({ [key]: input.checked }).catch(() => {});
    });
  }
}

/* ------------------------------------------------------------------ *
 * Recent snips
 * ------------------------------------------------------------------ */

async function renderHistory(known) {
  let history = known;
  if (!history) {
    const data = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
    history = data[HISTORY_KEY];
  }

  gridEl.replaceChildren();
  clearBtn.hidden = history.length === 0;

  if (history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.innerHTML =
      "<strong>No snips yet</strong>Press the shortcut on any page, then drag.";
    gridEl.append(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of history) frag.append(buildTile(item, history));
  gridEl.append(frag);
}

function buildTile(item, history) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile";
  const dims = `${item.w} × ${item.h}`;
  tile.title = `${dims} — ${new Date(item.ts).toLocaleString()}\nClick to copy`;

  const img = document.createElement("img");
  img.className = "tile__img";
  img.alt = `Snip, ${dims}`;
  img.loading = "lazy";
  img.decoding = "async";
  img.src = item.thumb || item.full;

  const meta = document.createElement("span");
  meta.className = "tile__meta";
  meta.textContent = dims;

  const tools = document.createElement("span");
  tools.className = "tile__tools";
  tools.append(
    toolButton("save", "Save as .png", (e) => {
      e.stopPropagation();
      saveItem(item);
    }),
    toolButton("trash", "Delete", (e) => {
      e.stopPropagation();
      removeItem(item, history);
    })
  );

  tile.append(img, meta, tools);
  tile.addEventListener("click", () => copyItem(item, tile));
  return tile;
}

function toolButton(icon, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tool";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>`;
  b.addEventListener("click", onClick);
  return b;
}

async function copyItem(item, tile) {
  try {
    const blob = await toBlob(item.full);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    tile.dataset.flash = "1";
    setTimeout(() => delete tile.dataset.flash, 900);
  } catch {
    snack("Couldn’t copy that snip");
  }
}

async function saveItem(item) {
  try {
    const blob = await toBlob(item.full);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename(item.ts);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    snack("Saved");
  } catch {
    snack("Couldn’t save that snip");
  }
}

async function removeItem(item, history) {
  const next = history.filter((x) => x.id !== item.id);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  renderHistory(next);
}

let clearArmed = 0;

// Two-tap confirm instead of a blocking window.confirm() dialog.
async function clearHistory() {
  if (Date.now() > clearArmed) {
    clearArmed = Date.now() + 3000;
    clearBtn.textContent = "Clear all?";
    setTimeout(() => {
      clearBtn.textContent = "Clear";
      clearArmed = 0;
    }, 3000);
    return;
  }
  clearArmed = 0;
  clearBtn.textContent = "Clear";
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  renderHistory([]);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function toBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

function filename(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `snip-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(ts) {
  const seconds = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  return RELATIVE.format(Math.round(seconds / 86400), "day");
}

let snackTimer = 0;

function snack(message) {
  clearTimeout(snackTimer);
  snackEl.textContent = message;
  snackEl.hidden = false;
  requestAnimationFrame(() => {
    snackEl.dataset.show = "1";
  });
  snackTimer = setTimeout(() => {
    snackEl.dataset.show = "0";
  }, 1600);
}
