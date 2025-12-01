// content.js
(() => {
  if (window.__snipInBrowserInjected) return;
  window.__snipInBrowserInjected = true;

  const COLORS = {
    mask: "rgba(0,0,0,0.5)",
    border: "#2563EB",
    handle: "#FFFFFF",
    toastBg: "#1F2937",
    toastText: "#F3F4F6",
  };

  let overlay, selection, toolbar;
  let maskTop, maskLeft, maskRight, maskBottom;
  let startX = 0,
    startY = 0;
  let dragging = false,
    moving = false,
    resizing = false;
  let activeHandle = null;

  // Settings
  let autoCopyAndClose = true;
  let isProcessing = false;

  // --- UI CREATION ---
  function ensureUI() {
    if (overlay) return;

    overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647; 
      cursor: crosshair; user-select: none; touch-action: none;
    `;

    const mkDiv = () => {
      const d = document.createElement("div");
      d.style.cssText = `position: absolute; background: ${COLORS.mask}; pointer-events: none;`;
      return d;
    };
    maskTop = mkDiv();
    maskLeft = mkDiv();
    maskRight = mkDiv();
    maskBottom = mkDiv();

    selection = document.createElement("div");
    selection.style.cssText = `
      position: absolute; display: none; 
      border: 2px solid ${COLORS.border}; 
      background: transparent; cursor: move; 
      box-shadow: 0 0 0 1px rgba(255,255,255,0.2);
    `;

    // Add Handles
    ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach((pos) => {
      const h = document.createElement("div");
      h.className = "snip-handle";
      h.dataset.pos = pos;
      h.style.cssText = `
        position: absolute; width: 10px; height: 10px;
        background: ${COLORS.handle}; border: 1px solid #999;
        border-radius: 50%; box-sizing: border-box; z-index: 2;
      `;
      selection.appendChild(h);
    });

    // Toolbar
    toolbar = document.createElement("div");
    toolbar.className = "snip-toolbar"; // Class for checking clicks
    toolbar.style.cssText = `
      position: absolute; display: none; gap: 8px; padding: 6px;
      background: white; border-radius: 6px; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-family: sans-serif;
      z-index: 2147483648; /* Higher than overlay */
    `;

    // CRITICAL FIX: Stop mousedown propagation so dragging doesn't start
    toolbar.onmousedown = (e) => e.stopPropagation();

    const btn = (text, cb) => {
      const b = document.createElement("div");
      b.textContent = text;
      b.style.cssText = `
        padding: 4px 12px; background: #f3f4f6; color: #1f2937;
        font-size: 13px; border-radius: 4px; cursor: pointer; border: 1px solid #e5e7eb;
      `;
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        cb();
      };
      return b;
    };

    // Buttons
    toolbar.append(btn("Cancel", removeUI));

    // "Copy" button manually triggers the "Copy & Close" logic
    const copyBtn = btn("Copy & Close", () => captureAndCopy(true));
    copyBtn.style.background = "#2563EB";
    copyBtn.style.color = "#FFF";
    toolbar.append(copyBtn);

    overlay.append(
      maskTop,
      maskLeft,
      maskRight,
      maskBottom,
      selection,
      toolbar
    );
    document.documentElement.appendChild(overlay);

    overlay.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove, { capture: true });
    window.addEventListener("mouseup", onMouseUp, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
  }

  function removeUI() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    selection = null;
    dragging = moving = resizing = false;
    isProcessing = false;
  }

  // --- MOUSE LOGIC ---
  function onMouseDown(e) {
    if (e.button !== 0) return;
    // Check if clicking toolbar (Safety check, though stopPropagation above handles it)
    if (e.target.closest(".snip-toolbar")) return;

    if (selection.style.display !== "none") {
      if (e.target.classList.contains("snip-handle")) {
        resizing = true;
        activeHandle = e.target.dataset.pos;
        return;
      } else if (e.target === selection) {
        moving = true;
        const r = selection.getBoundingClientRect();
        selection.dataset.offX = e.clientX - r.left;
        selection.dataset.offY = e.clientY - r.top;
        return;
      }
    }
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    selection.style.display = "block";
    toolbar.style.display = "none"; // Hide toolbar during new drag
    updateSelection(startX, startY, 0, 0);
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!overlay) return;
    if (dragging) {
      const w = e.clientX - startX;
      const h = e.clientY - startY;
      updateSelection(
        w > 0 ? startX : e.clientX,
        h > 0 ? startY : e.clientY,
        Math.abs(w),
        Math.abs(h)
      );
    } else if (moving) {
      const nx = e.clientX - parseFloat(selection.dataset.offX);
      const ny = e.clientY - parseFloat(selection.dataset.offY);
      updateSelection(nx, ny, selection.offsetWidth, selection.offsetHeight);
    } else if (resizing) {
      const r = selection.getBoundingClientRect();
      updateSelection(
        r.left + e.movementX,
        r.top + e.movementY,
        r.width + e.movementX,
        r.height + e.movementY
      );
    }
  }

  function onMouseUp() {
    if (!dragging && !resizing && !moving) return;
    dragging = moving = resizing = false;

    const w = selection.offsetWidth,
      h = selection.offsetHeight;
    if (w < 5 || h < 5) {
      selection.style.display = "none";
      return;
    }

    // --- LOGIC CHANGE ---
    if (autoCopyAndClose) {
      // Mode 1: Auto Copy & Close
      captureAndCopy(true);
    } else {
      // Mode 2: Auto Copy & Keep Open (Live Copy)
      captureAndCopy(false);
    }
  }

  function updateSelection(x, y, w, h) {
    const mx = window.innerWidth,
      my = window.innerHeight;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + w > mx) w = mx - x;
    if (y + h > my) h = my - y;
    selection.style.left = x + "px";
    selection.style.top = y + "px";
    selection.style.width = w + "px";
    selection.style.height = h + "px";

    maskTop.style.cssText += `left:0; top:0; width:100%; height:${y}px`;
    maskBottom.style.cssText += `left:0; top:${y + h}px; width:100%; height:${
      my - (y + h)
    }px`;
    maskLeft.style.cssText += `left:0; top:${y}px; width:${x}px; height:${h}px`;
    maskRight.style.cssText += `left:${x + w}px; top:${y}px; width:${
      mx - (x + w)
    }px; height:${h}px`;

    const midX = w / 2 - 5,
      midY = h / 2 - 5;
    const pos = {
      nw: [-5, -5],
      n: [midX, -5],
      ne: [w - 5, -5],
      w: [-5, midY],
      e: [w - 5, midY],
      sw: [-5, h - 5],
      s: [midX, h - 5],
      se: [w - 5, h - 5],
    };
    Array.from(selection.children).forEach((k) => {
      if (pos[k.dataset.pos]) {
        k.style.left = pos[k.dataset.pos][0] + "px";
        k.style.top = pos[k.dataset.pos][1] + "px";
      }
    });
  }

  function onKeyDown(e) {
    if (!overlay) return;
    if (e.key === "Escape") removeUI();
    if (e.key === "Enter") captureAndCopy(true); // Enter forces Copy & Close
  }

  // --- CAPTURE & HISTORY ---
  function saveToHistory(dataUrl) {
    chrome.storage.local.get({ snipHistory: [] }, (result) => {
      const history = result.snipHistory;
      const newItem = {
        id: Date.now(),
        dataUrl: dataUrl,
        timestamp: new Date().toLocaleString(),
      };
      const updatedHistory = [newItem, ...history].slice(0, 10);
      chrome.storage.local.set({ snipHistory: updatedHistory });
    });
  }

  async function captureAndCopy(shouldClose) {
    if (isProcessing) return;
    isProcessing = true;

    // Hide UI elements before capture
    selection.style.opacity = "0";
    toolbar.style.display = "none";

    await new Promise((r) => setTimeout(r, 50));

    try {
      const response = await chrome.runtime.sendMessage({
        type: "CAPTURE_VISIBLE",
      });
      if (!response?.ok) throw new Error("Capture failed");

      const rect = selection.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(
          img,
          rect.left * dpr,
          rect.top * dpr,
          rect.width * dpr,
          rect.height * dpr,
          0,
          0,
          rect.width * dpr,
          rect.height * dpr
        );

        canvas.toBlob((blob) => {
          navigator.clipboard
            .write([new ClipboardItem({ "image/png": blob })])
            .then(() => {
              const reader = new FileReader();
              reader.readAsDataURL(blob);
              reader.onloadend = () => saveToHistory(reader.result);

              showToast();

              if (shouldClose) {
                selection.style.opacity = "1";
                setTimeout(() => {
                  removeUI();
                }, 800);
              } else {
                // LIVE COPY MODE: Restore UI
                selection.style.opacity = "1";

                // Show Toolbar again
                toolbar.style.display = "flex";
                const r = selection.getBoundingClientRect();
                let tTop = r.top - 50;
                if (tTop < 10) tTop = r.bottom + 10;
                toolbar.style.top = tTop + "px";
                toolbar.style.left = r.left + "px";

                isProcessing = false;
              }
            });
        });
      };
      img.src = response.dataUrl;
    } catch (e) {
      console.error(e);
      selection.style.opacity = "1";
      isProcessing = false;
    }
  }

  function showToast() {
    // Remove existing toast if any (to prevent stack up)
    const existing = document.getElementById("snip-toast");
    if (existing) existing.remove();

    const t = document.createElement("div");
    t.id = "snip-toast";
    t.textContent = "Copied!";
    t.style.cssText = `
      position: fixed; top: 20px; right: 20px; z-index: 2147483648;
      background: ${COLORS.toastBg}; color: ${COLORS.toastText};
      padding: 8px 16px; border-radius: 6px; font-family: sans-serif;
      font-weight: 500; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      transform: translateY(-20px); opacity: 0; transition: all 0.2s ease;
      pointer-events: none;
    `;
    document.body.appendChild(t);
    requestAnimationFrame(() => {
      t.style.transform = "translateY(0)";
      t.style.opacity = "1";
    });
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 300);
    }, 1200);
  }

  // --- MESSAGE LISTENER ---
  chrome.runtime.onMessage.addListener((msg) => {
    const start = () => {
      chrome.storage.sync.get({ autoCopyOnMouseup: true }, (d) => {
        autoCopyAndClose = !!d.autoCopyOnMouseup;
        ensureUI();
      });
    };

    if (msg.type === "TOGGLE_SNIP") {
      if (overlay) {
        removeUI();
      } else {
        start();
      }
    }

    if (msg.type === "START_SNIP") {
      start();
    }
  });
})();
