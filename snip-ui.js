/**
 * snip-ui.js - the selection engine.
 *
 * Shared verbatim by the in-page overlay (content.js) and the standalone snip
 * window (editor.js) so both behave identically. It is a plain script that
 * publishes window.__SnipUI, not a module, because content scripts injected via
 * chrome.scripting.executeScript cannot use import.
 *
 * It never captures the screen itself. It is handed an already-decoded
 * screenshot and a stage size, and its only job is: let the user pick a
 * rectangle, then crop / copy / save it.
 */
(() => {
  // Deliberately no "already defined" guard: chrome.scripting.executeScript
  // re-runs this file on every snip, and after an extension update the freshest
  // definition must be the one that wins.
  const HANDLES = ["nw", "n", "ne", "w", "e", "sw", "s", "se"];
  const MIN_PIXELS = 4; // below this a drag is treated as a stray click
  const THUMB_WIDTH = 220;

  const CSS = `
:host, .snip-root, .snip-root * { box-sizing: border-box; }

.snip-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
  cursor: crosshair;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  font: 400 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        Helvetica, Arial, sans-serif;
  color: #fff;
  /* Vermilion, taken from the crop marks in the product icon. It stays legible
     against the untouched screenshot inside the marquee and the dimmed page
     outside it, and it will not be mistaken for page chrome the way a blue
     would. */
  --accent: #ff4a17;
  --dim: rgba(18, 16, 14, 0.5);
  --panel: #17150f;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono",
          "Roboto Mono", Menlo, Consolas, monospace;
}

.snip-shot {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
  pointer-events: none;
  -webkit-user-drag: none;
}

/* Full-surface dim, shown only until the first rectangle exists. */
.snip-veil {
  position: absolute;
  inset: 0;
  background: var(--dim);
  pointer-events: none;
}

/* Crosshair guides that track the pointer before the first drag. */
.snip-cross {
  position: absolute;
  background: var(--accent);
  opacity: 0.75;
  pointer-events: none;
  will-change: transform;
}
.snip-cross-v { top: 0; left: 0; width: 1px; height: 100%; }
.snip-cross-h { top: 0; left: 0; width: 100%; height: 1px; }

/* The selection. Its box-shadow paints the dim over everything outside it,
   which replaces the four mask elements v1 recalculated on every mousemove. */
.snip-box {
  position: absolute;
  top: 0;
  left: 0;
  cursor: move;
  border: 1.5px solid var(--accent);
  box-shadow: 0 0 0 100vmax var(--dim);
  will-change: transform, width, height;
}

/* Square, like every other crop tool. Round handles read as a slider. */
.snip-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  background: #fff;
  border: 1.5px solid var(--accent);
}
.snip-handle[data-pos="nw"] { left: 0;    top: 0;    cursor: nwse-resize; }
.snip-handle[data-pos="n"]  { left: 50%;  top: 0;    cursor: ns-resize; }
.snip-handle[data-pos="ne"] { left: 100%; top: 0;    cursor: nesw-resize; }
.snip-handle[data-pos="w"]  { left: 0;    top: 50%;  cursor: ew-resize; }
.snip-handle[data-pos="e"]  { left: 100%; top: 50%;  cursor: ew-resize; }
.snip-handle[data-pos="sw"] { left: 0;    top: 100%; cursor: nesw-resize; }
.snip-handle[data-pos="s"]  { left: 50%;  top: 100%; cursor: ns-resize; }
.snip-handle[data-pos="se"] { left: 100%; top: 100%; cursor: nwse-resize; }

/* Size readout, in pixels, so it is set in a monospace. */
.snip-hud {
  position: absolute;
  top: 0;
  left: 0;
  padding: 3px 6px;
  background: var(--panel);
  color: #fff;
  font: 500 11px/1.3 var(--mono);
  white-space: nowrap;
  pointer-events: none;
  will-change: transform;
}

/* Action bar. The one element here that genuinely floats over unknown page
   content, so the one element that earns a shadow. */
.snip-bar {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 3px;
  background: var(--panel);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  will-change: transform;
}
.snip-btn {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 6px 11px;
  border-radius: 2px;
  background: transparent;
  color: #e9e4dc;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.snip-btn:hover { background: rgba(255, 255, 255, 0.11); }
.snip-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.snip-btn--primary { background: var(--accent); color: #fff; font-weight: 600; }
.snip-btn--primary:hover { background: #e03d0e; }
.snip-sep { width: 1px; height: 18px; margin: 0 3px; background: rgba(255, 255, 255, 0.16); }

/* Intro hint. */
.snip-hint {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 12px;
  border-radius: 3px;
  background: var(--panel);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  white-space: nowrap;
  color: #cdc6bb;
}
.snip-hint kbd {
  display: inline-block;
  padding: 1px 4px;
  margin: 0 1px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 2px;
  color: #fff;
  font: 500 10.5px/1.3 var(--mono);
}

/* State machine: one attribute drives every visibility change. */
.snip-root[data-state="idle"] .snip-box,
.snip-root[data-state="idle"] .snip-hud,
.snip-root[data-state="idle"] .snip-bar { display: none; }
.snip-root:not([data-state="idle"]) .snip-veil,
.snip-root:not([data-state="idle"]) .snip-cross,
.snip-root:not([data-state="idle"]) .snip-hint { display: none; }
.snip-root[data-state="dragging"] .snip-bar { display: none; }
.snip-root[data-busy="1"] { cursor: progress; }
`;

  const MARKUP = `
<img class="snip-shot" alt="">
<div class="snip-veil"></div>
<div class="snip-cross snip-cross-v"></div>
<div class="snip-cross snip-cross-h"></div>
<div class="snip-hint">
  Drag to select &nbsp;·&nbsp; <kbd>Esc</kbd> cancel &nbsp;·&nbsp; <kbd data-mod>Ctrl</kbd>+<kbd>A</kbd> whole page
</div>
<div class="snip-box">${HANDLES.map(
    (p) => `<div class="snip-handle" data-pos="${p}"></div>`
  ).join("")}</div>
<div class="snip-hud">0 × 0</div>
<div class="snip-bar" role="toolbar" aria-label="Snip actions">
  <button type="button" class="snip-btn snip-btn--primary" data-act="copy">Copy</button>
  <button type="button" class="snip-btn" data-act="save">Save</button>
  <div class="snip-sep"></div>
  <button type="button" class="snip-btn" data-act="reset">Reselect</button>
  <button type="button" class="snip-btn" data-act="cancel">Cancel</button>
</div>
`;

  /**
   * @param {object} opts
   * @param {Element|ShadowRoot} opts.root  where to render
   * @param {HTMLImageElement}   opts.image already-decoded screenshot
   * @param {number} opts.width   CSS px the screenshot is displayed at
   * @param {number} opts.height
   * @param {object} [opts.settings] {autoCopy, closeAfterCopy, saveFile}
   * @param {(msg: string, tone: 'ok'|'warn') => void} [opts.onFlash]
   * @param {() => void} [opts.onClose]
   * @param {boolean} [opts.blockScroll] swallow wheel/scroll keys (page overlay)
   */
  function create(opts) {
    const settings = Object.assign(
      { autoCopy: true, closeAfterCopy: true, saveFile: false },
      opts.settings
    );
    const onFlash = opts.onFlash || (() => {});
    const onClose = opts.onClose || (() => {});

    const stageW = Math.max(1, opts.width);
    const stageH = Math.max(1, opts.height);
    // CSS size the capture is drawn at. Usually the same as the stage, but on a
    // page with a classic scrollbar the capture covers a slightly wider box than
    // a fixed overlay can reach, and drawing it at the stage size would both
    // resample it (soft on screen) and misalign the crop.
    const imageW = Math.max(1, opts.imageWidth || stageW);
    const imageH = Math.max(1, opts.imageHeight || stageH);
    // Image pixels per CSS pixel, measured per axis against the actual capture.
    // Deriving it from the image rather than devicePixelRatio handles Retina,
    // Windows display scaling and browser page zoom in one number. Keeping the
    // axes separate makes it self-correcting when the capture and the stage
    // cover slightly different regions - captureVisibleTab includes the classic
    // scrollbar strip that a fixed overlay cannot reach. Whatever is on screen
    // inside the stage is exactly what gets cropped either way.
    const scaleX = opts.image.naturalWidth / imageW;
    const scaleY = opts.image.naturalHeight / imageH;

    /* ---------------- DOM ---------------- */

    const style = document.createElement("style");
    style.textContent = CSS;

    const el = document.createElement("div");
    el.className = "snip-root";
    el.setAttribute("role", "application");
    el.setAttribute("aria-label", "Screenshot region selector");
    el.dataset.state = "idle";
    el.innerHTML = MARKUP;

    const shot = el.querySelector(".snip-shot");
    const crossV = el.querySelector(".snip-cross-v");
    const crossH = el.querySelector(".snip-cross-h");
    const box = el.querySelector(".snip-box");
    const hud = el.querySelector(".snip-hud");
    const bar = el.querySelector(".snip-bar");

    const isMac = /Mac|iPhone|iPad|iPod/.test(
      (navigator.userAgentData && navigator.userAgentData.platform) ||
        navigator.userAgent
    );
    if (isMac) {
      el.querySelectorAll("kbd[data-mod]").forEach((k) => (k.textContent = "⌘"));
    }

    shot.src = opts.image.src;
    // Explicit CSS size: never let the browser rescale the capture to fit.
    shot.style.width = `${imageW}px`;
    shot.style.height = `${imageH}px`;

    opts.root.append(style, el);

    /* ---------------- state ---------------- */

    let sel = null; // {x, y, w, h} in stage CSS px
    let gesture = null; // {kind, origin, start, pos}
    let stageOrigin = { x: 0, y: 0 };
    let barSize = { w: 0, h: 0 };
    let frame = 0;
    let busy = false;
    let dead = false;
    let lastHud = "";

    const listeners = [];
    function on(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      listeners.push([target, type, fn, options]);
    }

    /* ---------------- geometry ---------------- */

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

    function rectFromCorners(x1, y1, x2, y2) {
      const left = clamp(Math.min(x1, x2), 0, stageW);
      const top = clamp(Math.min(y1, y2), 0, stageH);
      const right = clamp(Math.max(x1, x2), 0, stageW);
      const bottom = clamp(Math.max(y1, y2), 0, stageH);
      return { x: left, y: top, w: right - left, h: bottom - top };
    }

    function movedRect(start, dx, dy) {
      return {
        x: clamp(start.x + dx, 0, stageW - start.w),
        y: clamp(start.y + dy, 0, stageH - start.h),
        w: start.w,
        h: start.h,
      };
    }

    // One expression per edge, so all eight handles are correct -- v1 applied
    // the same delta to both origin and size regardless of which handle was
    // grabbed, which made every handle behave like "resize from south-east".
    function resizedRect(start, pos, dx, dy) {
      let x1 = start.x;
      let y1 = start.y;
      let x2 = start.x + start.w;
      let y2 = start.y + start.h;
      if (pos.includes("n")) y1 += dy;
      if (pos.includes("s")) y2 += dy;
      if (pos.includes("w")) x1 += dx;
      if (pos.includes("e")) x2 += dx;
      return rectFromCorners(x1, y1, x2, y2);
    }

    function pointerPos(e) {
      return {
        x: clamp(e.clientX - stageOrigin.x, 0, stageW),
        y: clamp(e.clientY - stageOrigin.y, 0, stageH),
      };
    }

    function refreshOrigin() {
      const r = el.getBoundingClientRect();
      stageOrigin = { x: r.left, y: r.top };
    }

    /* ---------------- rendering ---------------- */

    // All visual updates funnel through one rAF-batched pass. Nothing in here
    // reads layout, so a fast drag costs one style write per frame instead of
    // v1's growing cssText string.
    function schedule() {
      if (!frame && !dead) frame = requestAnimationFrame(render);
    }

    function render() {
      frame = 0;
      if (dead) return;

      if (!sel) {
        el.dataset.state = "idle";
        return;
      }
      el.dataset.state = gesture ? "dragging" : "ready";

      const { x, y, w, h } = sel;
      box.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;

      const text = `${Math.round(w * scaleX)} × ${Math.round(h * scaleY)}`;
      if (text !== lastHud) {
        hud.textContent = text;
        lastHud = text;
      }
      // Above the selection when there is room, otherwise tucked just inside.
      const hudY = y >= 30 ? y - 28 : y + 6;
      hud.style.transform = `translate3d(${clamp(x, 0, stageW - 96)}px, ${hudY}px, 0)`;

      if (!gesture) positionBar(x, y, w, h);
    }

    function positionBar(x, y, w, h) {
      if (!barSize.w) barSize = { w: bar.offsetWidth, h: bar.offsetHeight };
      const gap = 10;
      let by = y + h + gap;
      if (by + barSize.h > stageH) by = y - barSize.h - gap; // flip above
      if (by < 0) by = clamp(y + h - barSize.h - gap, 0, stageH - barSize.h); // tuck inside
      const bx = clamp(x + w - barSize.w, 8, Math.max(8, stageW - barSize.w - 8));
      bar.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
    }

    function moveCrosshair(e) {
      const p = pointerPos(e);
      crossV.style.transform = `translate3d(${p.x}px, 0, 0)`;
      crossH.style.transform = `translate3d(0, ${p.y}px, 0)`;
    }

    /* ---------------- pointer ---------------- */

    on(el, "pointerdown", (e) => {
      if (e.button !== 0 || busy || dead) return;
      if (e.target.closest(".snip-bar")) return; // buttons handle themselves

      refreshOrigin();
      const p = pointerPos(e);
      const pos = e.target.dataset && e.target.dataset.pos;

      if (sel && pos) {
        gesture = { kind: "resize", pos, origin: p, start: { ...sel } };
      } else if (sel && e.target === box) {
        gesture = { kind: "move", origin: p, start: { ...sel } };
      } else {
        gesture = { kind: "new", origin: p, start: null };
        sel = { x: p.x, y: p.y, w: 0, h: 0 };
      }

      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture is an optimisation, not a requirement */
      }
      e.preventDefault();
      schedule();
    });

    on(el, "pointermove", (e) => {
      if (dead) return;
      if (!gesture) {
        if (!sel) moveCrosshair(e);
        return;
      }
      const p = pointerPos(e);
      const dx = p.x - gesture.origin.x;
      const dy = p.y - gesture.origin.y;

      if (gesture.kind === "new") {
        sel = rectFromCorners(gesture.origin.x, gesture.origin.y, p.x, p.y);
      } else if (gesture.kind === "move") {
        sel = movedRect(gesture.start, dx, dy);
      } else {
        sel = resizedRect(gesture.start, gesture.pos, dx, dy);
      }
      schedule();
    });

    const endGesture = (e) => {
      if (!gesture || dead) return;
      gesture = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }

      // A click with no meaningful drag clears the selection instead of
      // leaving a 1px sliver behind.
      if (!sel || sel.w * scaleX < MIN_PIXELS || sel.h * scaleY < MIN_PIXELS) {
        sel = null;
        schedule();
        return;
      }
      schedule();
      if (settings.autoCopy) commit({ copy: true });
    };
    on(el, "pointerup", endGesture);
    on(el, "pointercancel", endGesture);

    on(bar, "click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      e.preventDefault();
      switch (btn.dataset.act) {
        case "copy":
          commit({ copy: true });
          break;
        case "save":
          commit({ copy: false, save: true });
          break;
        case "reset":
          sel = null;
          schedule();
          break;
        case "cancel":
          close();
          break;
      }
    });

    /* ---------------- keyboard ---------------- */

    on(
      window,
      "keydown",
      (e) => {
        if (dead) return;
        const mod = e.ctrlKey || e.metaKey;
        const step = e.shiftKey ? 10 : 1;
        let handled = true;

        if (e.key === "Escape") {
          close();
        } else if (mod && (e.key === "a" || e.key === "A")) {
          sel = { x: 0, y: 0, w: stageW, h: stageH };
          schedule();
        } else if (mod && (e.key === "c" || e.key === "C")) {
          commit({ copy: true });
        } else if (mod && (e.key === "s" || e.key === "S")) {
          commit({ copy: false, save: true });
        } else if (e.key === "Enter") {
          if (sel) commit({ copy: true });
        } else if (e.key.startsWith("Arrow") && sel) {
          const dx =
            (e.key === "ArrowRight" ? step : 0) - (e.key === "ArrowLeft" ? step : 0);
          const dy =
            (e.key === "ArrowDown" ? step : 0) - (e.key === "ArrowUp" ? step : 0);
          // Alt resizes from the bottom-right corner; plain arrows nudge.
          sel = e.altKey
            ? resizedRect(sel, "se", dx, dy)
            : movedRect(sel, dx, dy);
          schedule();
        } else {
          handled = false;
        }

        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );

    if (opts.blockScroll) {
      // Keep the page still: the screenshot underneath is frozen, so letting
      // the real page scroll would make the overlay lie about what it captures.
      const swallow = (e) => e.preventDefault();
      on(window, "wheel", swallow, { passive: false, capture: true });
      on(window, "touchmove", swallow, { passive: false, capture: true });
    }

    if (opts.closeOnResize) {
      // The frozen screenshot no longer matches the viewport, so the overlay
      // would crop the wrong region. Bail out rather than lie.
      on(window, "resize", close);
    }

    /* ---------------- capture pipeline ---------------- */

    /**
     * The source rectangle is snapped to whole image pixels and the canvas is
     * sized to match it exactly, so drawImage copies pixels 1:1 instead of
     * resampling. A fractional source rect - which is what you get the moment
     * the scale is not a clean integer - runs the whole crop through a bilinear
     * filter and softens every edge in it.
     */
    function crop() {
      const maxW = opts.image.naturalWidth;
      const maxH = opts.image.naturalHeight;
      const sx = clamp(Math.round(sel.x * scaleX), 0, maxW - 1);
      const sy = clamp(Math.round(sel.y * scaleY), 0, maxH - 1);
      const sw = clamp(Math.round(sel.w * scaleX), 1, maxW - sx);
      const sh = clamp(Math.round(sel.h * scaleY), 1, maxH - sy);

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(opts.image, sx, sy, sw, sh, 0, 0, sw, sh);
      return canvas;
    }

    function toBlob(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("encoding failed"))),
          "image/png"
        );
      });
    }

    async function writeClipboard(blob, canvas) {
      try {
        if (!navigator.clipboard || !navigator.clipboard.write) {
          throw new Error("Clipboard API unavailable");
        }
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        return true;
      } catch {
        // Most often an http:// page: the Clipboard API is only exposed to
        // secure contexts. Hand it to the service worker instead.
        try {
          const res = await chrome.runtime.sendMessage({
            type: "COPY_IMAGE",
            dataUrl: canvas.toDataURL("image/png"),
          });
          return !!(res && res.ok);
        } catch {
          return false;
        }
      }
    }

    function saveBlob(blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename();
      a.rel = "noopener";
      a.style.display = "none";
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function filename() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      return `snip-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(
        d.getDate()
      )}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
    }

    // Deferred so encoding a full-resolution PNG never delays the visible
    // response to the user.
    function record(canvas) {
      setTimeout(() => {
        try {
          const item = {
            id: Date.now(),
            ts: Date.now(),
            w: canvas.width,
            h: canvas.height,
            thumb: makeThumb(canvas),
            full: canvas.toDataURL("image/png"),
          };
          chrome.runtime
            .sendMessage({ type: "ADD_HISTORY", item })
            .catch(() => {});
        } catch {
          /* history is a convenience; never let it break a snip */
        }
      }, 0);
    }

    function makeThumb(canvas) {
      const w = Math.min(THUMB_WIDTH, canvas.width);
      const h = Math.max(1, Math.round((canvas.height / canvas.width) * w));
      const t = document.createElement("canvas");
      t.width = w;
      t.height = h;
      const ctx = t.getContext("2d", { alpha: false });
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(canvas, 0, 0, w, h);
      return t.toDataURL("image/jpeg", 0.72);
    }

    async function commit({ copy = true, save = false } = {}) {
      if (busy || dead || !sel || sel.w < 1 || sel.h < 1) return;
      busy = true;
      el.dataset.busy = "1";
      try {
        const canvas = crop();
        const blob = await toBlob(canvas);
        const alsoSave = save || (copy && settings.saveFile);

        const copied = copy ? await writeClipboard(blob, canvas) : false;
        if (alsoSave) saveBlob(blob);
        record(canvas);

        if (copy && !copied) {
          onFlash("Couldn't reach the clipboard — saved to Recent", "warn");
          return;
        }
        onFlash(
          copy ? (alsoSave ? "Copied & saved" : "Copied") : "Saved",
          "ok"
        );
        // Close immediately rather than sitting on a timer: the confirmation
        // toast outlives the overlay, so there is nothing to wait for.
        if (copied && settings.closeAfterCopy) close();
      } catch (err) {
        onFlash(`Snip failed: ${err.message || err}`, "warn");
      } finally {
        busy = false;
        delete el.dataset.busy;
      }
    }

    /* ---------------- teardown ---------------- */

    function close() {
      if (dead) return;
      destroy();
      onClose();
    }

    function destroy() {
      if (dead) return;
      dead = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      for (const [target, type, fn, options] of listeners) {
        target.removeEventListener(type, fn, options);
      }
      listeners.length = 0;
      style.remove();
      el.remove();
    }

    refreshOrigin();
    // Measure the bar once, off the critical path, so positionBar never has to.
    requestAnimationFrame(() => {
      if (!dead) barSize = { w: bar.offsetWidth, h: bar.offsetHeight };
    });

    return { destroy, close, element: el };
  }

  window.__SnipUI = { create };
})();
