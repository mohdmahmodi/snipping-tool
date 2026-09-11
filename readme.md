<p align="center">
  <img src="icons/snipper.svg" width="96" height="96" alt="Snip In Browser logo" />
</p>

<h1 align="center">Snip In Browser</h1>

<p align="center">
  Drag a rectangle on any tab and it is on your clipboard. Including PDFs.
</p>

<p align="center">
  <a href="https://github.com/MohdYahyaMahmodi/snipping-tool/releases"><img src="https://img.shields.io/badge/Version-2.0.0-C93400?style=flat-square"></a>
  <a href="https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3"><img src="https://img.shields.io/badge/Manifest%20V3-%E2%9C%93-444?style=flat-square"></a>
  <a href="https://github.com/MohdYahyaMahmodi/snipping-tool/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-gray?style=flat-square"></a>
</p>

---

## What it does

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>S</kbd> on macOS), drag a
box, let go. The cropped PNG is on your clipboard. Nudge the region with the arrow
keys, resize it from any of the eight handles, or press <kbd>Esc</kbd> to bail out.

No frameworks, no network calls, no analytics. Vanilla JS, CSS and one PNG.

---

## Why v2

v1 worked on ordinary pages and fell over everywhere else. The rewrite is mostly
about the "everywhere else", plus making the common path fast.

| | v1 | v2 |
|---|---|---|
| **Speed** | The dim mask rebuilt its `style` attribute on every `mousemove` using `cssText +=`, so the string grew without bound and Chrome re-parsed a multi-kilobyte style each frame. | Selection state lives in JS; one rAF-batched write per frame moves a single `transform`. The dim is one `box-shadow`, not four elements. |
| **Latency** | Every copy hid the UI, waited 50 ms, took a fresh screenshot, then restored. Plus an 800 ms pause before closing. | The screenshot is taken **once**, before any UI exists. Cropping is pure canvas work, and the overlay closes instantly — the confirmation toast outlives it. |
| **Resize handles** | All eight applied the same delta to both origin and size, so every handle behaved like "drag the bottom-right corner". | One expression per edge. All eight verified, including dragging a handle past the opposite edge. |
| **PDFs** | Overlay appeared and ignored every click. | Detected, and snipped in a dedicated window instead. |
| **`chrome://`, Web Store, view-source** | Nothing happened. | Same dedicated window. |
| **Plain-HTTP sites** | Copy failed silently — `navigator.clipboard` is not exposed to insecure origins. | Falls back to an offscreen document. |
| **Popup button** | Sent a message to a content script that had never been injected, then closed. | Injects on demand, and reports the reason if it genuinely can't. |
| **Permissions** | `<all_urls>` — *"Read and change all your data on all websites."* | `activeTab`. No host permissions, no warning. |

---

## Why PDFs need a separate window

A content script *does* attach to a PDF tab — Chrome wraps the document in an
HTML page containing an `<embed>` — but the embedded viewer consumes every
pointer event before the page sees it. An overlay there renders perfectly and
responds to nothing, which is exactly the bug v1 had.

`chrome.tabs.captureVisibleTab` has no such limitation, and with `activeTab` it
is also allowed on `chrome://` pages, other extensions' pages and `data:` URLs.
So when the page can't host the overlay, the extension captures anyway and opens
the shot in its own window, where the identical selection UI runs. The
distinction is made by the page itself, not by URL guessing:

```js
if (document.contentType === "application/pdf") return { started: false, reason: "pdf" };
```

Ordinary web pages always get the in-page overlay. The window is a genuine last
resort, and it states which case it hit — PDF viewer, Chrome-restricted page, or
page styling that would misplace the overlay — instead of a vague "this page".

The one case that genuinely cannot work is `file://` URLs, because `activeTab`
does not extend to local files. The popup says so and points at the
"Allow access to file URLs" toggle rather than failing quietly.

> **Note on viewport measurement.** A `position: fixed` overlay spans
> `documentElement.clientWidth`, which excludes classic scrollbars, while
> `window.innerWidth` includes them — a ~15px gap on any scrollable page on
> Windows. Anything that measures the overlay against the viewport has to use
> the former, and the crop scale is derived per axis from the capture itself so
> it stays exact even when the capture covers the scrollbar strip that the
> overlay cannot reach.

---

## Architecture

```
background.js   service worker. Captures, decides overlay-vs-window, owns history.
snip-ui.js      the selection engine. Shared verbatim by both front ends.
content.js      mounts snip-ui in a closed shadow root on a web page.
editor.*        mounts snip-ui in a standalone window, for pages that can't.
offscreen.*     clipboard of last resort.
popup.*         start a snip, three settings, recent snips.
```

A snip starts with capture and injection running **together**:

```js
const capturing = chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
const injecting = chrome.scripting.executeScript({ … }).then(() => true, () => false);
```

Capturing before the UI exists is what removes the hide/wait/restore dance, keeps
the overlay out of its own screenshot, and holds the extension to **one**
`captureVisibleTab` call per snip — the API is throttled to two per second, which
v1's "live copy" mode tripped constantly.

Scale is derived from the capture itself, not from `devicePixelRatio`, which
covers Retina, Windows display scaling and browser page zoom together —
`devicePixelRatio` alone gets page zoom wrong:

```js
const scaleX = image.naturalWidth / imageWidth;   // CSS box the capture covers
const scaleY = image.naturalHeight / imageHeight;
```

`imageWidth` is the box the *capture* covers, which is not always the box the
overlay covers — see the scrollbar note above. The capture is drawn at exactly
that size rather than stretched to fit, and the crop snaps its source rectangle
to whole image pixels with the canvas sized to match:

```js
canvas.width = sw; canvas.height = sh;
ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);   // 1:1, no resampling
```

A fractional source rectangle runs the whole crop through a bilinear filter. On
a 1px-stripe test pattern that turns 85% of the output grey; snapped, it is a
byte-for-byte copy of the source region.

---

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Capture and script the tab you invoked the extension on. Granted per invocation, revoked on navigation. |
| `scripting` | Inject the overlay on demand. |
| `storage` | Three settings and the recent-snips list. |
| `unlimitedStorage` | Recent snips are full-resolution PNGs; without this they hit the quota and the write fails silently. No permission warning. |
| `offscreen` | Clipboard fallback for insecure-origin pages. |
| `clipboardWrite` | Used by that fallback. |

There are no `host_permissions`, so Chrome shows no "read your data on all
websites" warning at install.

---

## Install

```bash
git clone https://github.com/MohdYahyaMahmodi/snipping-tool.git
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
and select the folder. Requires Chrome 116 or newer.

---

## Keyboard

| Key | Action |
|---|---|
| <kbd>Ctrl/⌘</kbd>+<kbd>⇧</kbd>+<kbd>S</kbd> | Start a snip (press again to cancel) |
| Drag | Select a region |
| Arrows | Move the selection by 1px (<kbd>⇧</kbd> for 10px) |
| <kbd>Alt</kbd>+Arrows | Resize the selection |
| <kbd>Ctrl/⌘</kbd>+<kbd>A</kbd> | Select the whole visible page |
| <kbd>Enter</kbd> / <kbd>Ctrl/⌘</kbd>+<kbd>C</kbd> | Copy |
| <kbd>Ctrl/⌘</kbd>+<kbd>S</kbd> | Save a .png |
| <kbd>Esc</kbd> | Cancel |

Rebind the shortcut at `chrome://extensions/shortcuts`, or by clicking the key
chip in the popup. The popup always displays the shortcut actually registered,
read from `chrome.commands.getAll()`.

---

## Settings

- **Copy when I release the mouse** — off means pick the region first, then press Copy.
- **Close after copying** — off keeps the overlay up so you can keep refining the same region.
- **Also save a .png file** — downloads alongside the copy.

---

## Design

The accent is the vermilion of the crop marks in the product icon. Neutrals are
warm so they sit in the same temperature family; radii stop at 3px; surfaces are
hairlines and flat fills, with shadows reserved for the one element that genuinely
floats over unknown page content. Every number — dimensions, shortcuts, sizes —
is set in a monospace, because numbers are what a snipping tool is actually about.
No gradients anywhere.

---

## License

MIT. © 2026 Mohd Mahmodi.

<p align="center">
  <sub>Built by <a href="https://github.com/MohdYahyaMahmodi">Mohd Mahmodi</a></sub>
</p>
