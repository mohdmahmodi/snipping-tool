/**
 * content.js - hosts the selection engine inside a web page.
 *
 * Deliberately thin: it owns page-specific concerns (style isolation, PDF
 * detection, the confirmation toast) and delegates everything about selecting
 * and cropping to snip-ui.js, which the standalone window uses too.
 */
(() => {
  // chrome.scripting.executeScript re-runs this file on every snip, so instead
  // of refusing to run twice we retire the previous instance. A plain boolean
  // guard would leave the page permanently deaf after an extension reload: the
  // flag survives, the old listener does not.
  if (typeof window.__snipInBrowserRetire === "function") {
    try {
      window.__snipInBrowserRetire();
    } catch {
      /* previous instance belonged to a torn-down extension context */
    }
  }

  const SETTINGS_DEFAULTS = {
    autoCopy: true,
    closeAfterCopy: true,
    saveFile: false,
  };

  let session = null;
  let host = null;

  function onMessage(msg, _sender, sendResponse) {
    if (!msg || msg.type !== "SNIP_START") return undefined;
    handleStart(msg).then(sendResponse, (err) =>
      sendResponse({ started: false, reason: describe(err) })
    );
    return true; // async response
  }
  chrome.runtime.onMessage.addListener(onMessage);

  window.__snipInBrowserRetire = () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    teardown();
    if (toastHost) toastHost.remove();
    clearTimeout(toastTimer);
  };

  async function handleStart(msg) {
    // Chrome's PDF viewer renders through an <embed> that consumes every
    // pointer event, so an overlay here would look correct and never respond.
    // Declining lets the service worker open the standalone snip window.
    if (isPdfDocument()) return { started: false, reason: "pdf" };

    if (session) {
      teardown();
      // The keyboard shortcut toggles; the popup button always starts fresh.
      if (msg.intent === "toggle") return { started: true };
    }

    const [image, settings] = await Promise.all([
      decode(msg.dataUrl),
      loadSettings(),
    ]);

    host = document.createElement("div");
    host.setAttribute("data-snip-in-browser", "");
    // Inline + !important outranks any page rule, including page !important.
    host.style.cssText = [
      "all: initial !important",
      "position: fixed !important",
      "inset: 0 !important",
      "width: 100% !important",
      "height: 100% !important",
      "margin: 0 !important",
      "z-index: 2147483647 !important",
      "display: block !important",
      "opacity: 1 !important",
      "visibility: visible !important",
      "pointer-events: auto !important",
      "transform: none !important",
      "filter: none !important",
    ].join(";");
    (document.documentElement || document.body).appendChild(host);

    // A transformed or filtered <html> element (some dark-mode extensions do
    // this) becomes the containing block for position:fixed, which would put
    // the overlay somewhere other than the viewport. Verify rather than assume.
    //
    // Compare against documentElement.clientWidth, NOT window.innerWidth: a
    // fixed element spans the viewport minus classic scrollbars, so on Windows
    // the two differ by ~15px on any scrollable page. Tolerances are loose on
    // purpose - this guards against gross misplacement, and a false positive
    // here needlessly kicks an ordinary page out to the standalone window.
    const view = viewport();
    const rect = host.getBoundingClientRect();
    const slack = (n) => Math.max(8, n * 0.05);
    const fits =
      Math.abs(rect.width - view.width) <= slack(view.width) &&
      Math.abs(rect.height - view.height) <= slack(view.height) &&
      Math.abs(rect.left) <= 8 &&
      Math.abs(rect.top) <= 8;
    if (!fits) {
      teardown();
      return { started: false, reason: "overlay-misplaced" };
    }

    const box = captureBox(image, view);
    const shadow = host.attachShadow({ mode: "closed" });
    session = window.__SnipUI.create({
      root: shadow,
      image,
      width: view.width,
      height: view.height,
      imageWidth: box.width,
      imageHeight: box.height,
      settings,
      blockScroll: true,
      closeOnResize: true,
      onFlash: flash,
      onClose: teardown,
    });

    return { started: true };
  }

  function teardown() {
    if (session) {
      session.destroy();
      session = null;
    }
    if (host) {
      host.remove();
      host = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Confirmation toast
   *
   * Lives in its own detached host so it outlives the overlay. That is what
   * lets a successful snip dismiss instantly instead of sitting on the
   * 800ms timer v1 needed to keep its toast on screen.
   * ------------------------------------------------------------------ */

  let toastHost = null;
  let toastTimer = 0;

  function flash(text, tone) {
    clearTimeout(toastTimer);
    if (toastHost) toastHost.remove();

    toastHost = document.createElement("div");
    toastHost.style.cssText = [
      "all: initial !important",
      "position: fixed !important",
      "top: 16px !important",
      "right: 16px !important",
      "z-index: 2147483647 !important",
      "pointer-events: none !important",
    ].join(";");

    const shadow = toastHost.attachShadow({ mode: "closed" });
    const node = document.createElement("div");
    node.textContent = text;
    node.style.cssText = `
      padding: 8px 13px;
      border-radius: 3px;
      background: #17150f;
      color: ${tone === "warn" ? "#ff6a3d" : "#ffffff"};
      font: 500 12.5px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI",
            Roboto, Helvetica, Arial, sans-serif;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
      opacity: 0;
      transition: opacity .12s ease;
    `;
    shadow.append(node);
    (document.documentElement || document.body).appendChild(toastHost);

    requestAnimationFrame(() => {
      node.style.opacity = "1";
    });

    const life = tone === "warn" ? 2600 : 1300;
    toastTimer = setTimeout(() => {
      node.style.opacity = "0";
      setTimeout(() => {
        if (toastHost) toastHost.remove();
        toastHost = null;
      }, 180);
    }, life);
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  // The area a position:fixed overlay can actually cover - the viewport with
  // classic scrollbars excluded. window.innerWidth includes them and would
  // overstate the stage.
  function viewport() {
    const el = document.documentElement;
    return {
      width: (el && el.clientWidth) || window.innerWidth,
      height: (el && el.clientHeight) || window.innerHeight,
    };
  }

  /**
   * The CSS box the capture covers, which is not always the box the overlay can
   * cover. captureVisibleTab may include the classic scrollbar strip; a fixed
   * overlay cannot reach it.
   *
   * Rather than assume either way, test which candidate is self-consistent: the
   * true box is the one whose width and height imply the same scale factor.
   * When there is no scrollbar the two candidates are identical and this is a
   * no-op.
   */
  function captureBox(image, view) {
    const withBars = { width: window.innerWidth, height: window.innerHeight };
    if (withBars.width === view.width && withBars.height === view.height) {
      return view;
    }
    const skew = (b) =>
      Math.abs(image.naturalWidth / b.width - image.naturalHeight / b.height);
    return skew(withBars) <= skew(view) ? withBars : view;
  }

  function isPdfDocument() {
    if (document.contentType === "application/pdf") return true;
    // A page-filling PDF plugin, as opposed to a small inline embed that a
    // normal overlay can still sit on top of.
    const embed = document.querySelector(
      'embed[type="application/pdf"], object[type="application/pdf"]'
    );
    if (!embed) return false;
    const r = embed.getBoundingClientRect();
    const view = viewport();
    return r.width >= view.width * 0.9 && r.height >= view.height * 0.9;
  }

  function decode(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Screenshot could not be decoded"));
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

  function describe(err) {
    return (err && err.message) || String(err) || "unknown error";
  }
})();
