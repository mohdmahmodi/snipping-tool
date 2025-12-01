// background.js

// Handle keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "start-snip") {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      // We pass a TOGGLE command
      chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SNIP" }).catch(() => {
        // If message fails, inject script then send message
        chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
          })
          .then(() => {
            chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SNIP" });
          });
      });
    }
  }
});

// Handle screenshot capture request from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "CAPTURE_VISIBLE") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, dataUrl });
      }
    });
    return true; // Keep channel open for async response
  }
});
