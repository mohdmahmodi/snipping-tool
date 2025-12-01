// popup.js

function isMac() {
  return navigator.platform.toUpperCase().indexOf("MAC") >= 0;
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function copyToClipboard(dataUrl) {
  try {
    const blob = await dataUrlToBlob(dataUrl);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch (err) {
    console.error("Copy failed", err);
    return false;
  }
}

// Render the history list
function renderHistory() {
  const list = document.getElementById("history-list");

  // FIX: Safety check to prevent the crash you saw
  if (!list) {
    console.error("Could not find history-list element");
    return;
  }

  chrome.storage.local.get({ snipHistory: [] }, (data) => {
    const history = data.snipHistory;
    list.innerHTML = "";

    if (history.length === 0) {
      list.innerHTML =
        '<div class="empty-state">No recent snips captured.</div>';
      return;
    }

    history.forEach((item) => {
      const el = document.createElement("div");
      el.className = "history-item";

      el.innerHTML = `
        <img src="${item.dataUrl}" class="history-thumb" />
        <div class="history-content">
          <span class="history-date">${item.timestamp}</span>
          <div class="history-actions">
            <button class="btn-small btn-copy">Copy</button>
            <button class="btn-small btn-del">Delete</button>
          </div>
        </div>
      `;

      // Copy Action
      const copyBtn = el.querySelector(".btn-copy");
      copyBtn.addEventListener("click", async () => {
        const originalText = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        copyBtn.style.color = "var(--primary)";
        copyBtn.style.borderColor = "var(--primary)";

        await copyToClipboard(item.dataUrl);

        setTimeout(() => {
          copyBtn.textContent = originalText;
          copyBtn.style.color = "";
          copyBtn.style.borderColor = "";
        }, 1500);
      });

      // Delete Action
      el.querySelector(".btn-del").addEventListener("click", () => {
        const newHistory = history.filter((x) => x.id !== item.id);
        chrome.storage.local.set({ snipHistory: newHistory }, renderHistory);
      });

      list.appendChild(el);
    });
  });
}

// Initialize everything when the DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  // 1. Set Shortcut Text
  const scLabel = document.getElementById("sc-global");
  if (scLabel) scLabel.textContent = isMac() ? "⌘⇧S" : "Ctrl+Shift+S";

  // 2. Initialize Checkbox
  const checkbox = document.getElementById("autoCopy");
  if (checkbox) {
    chrome.storage.sync.get({ autoCopyOnMouseup: true }, (data) => {
      checkbox.checked = data.autoCopyOnMouseup;
    });
    checkbox.addEventListener("change", () => {
      chrome.storage.sync.set({ autoCopyOnMouseup: checkbox.checked });
    });
  }

  // 3. Initialize Start Button
  const startBtn = document.getElementById("start");
  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: "START_SNIP" });
        window.close();
      }
    });
  }

  // 4. Clear History Button
  const clearBtn = document.getElementById("clear-history");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("Clear all history?")) {
        chrome.storage.local.set({ snipHistory: [] }, renderHistory);
      }
    });
  }

  // 5. Render History
  renderHistory();
});
