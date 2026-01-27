/**
 * Content script - provides viewport info and draws box overlays
 */

// Container for box overlays
let boxContainer: HTMLDivElement | null = null;

// Create or get box container
function getBoxContainer(): HTMLDivElement {
  if (!boxContainer) {
    boxContainer = document.createElement("div");
    boxContainer.id = "agent-box-container";
    boxContainer.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;";
    document.body.appendChild(boxContainer);
  }
  return boxContainer;
}

// Clear all boxes
function clearBoxes() {
  if (boxContainer) {
    boxContainer.innerHTML = "";
  }
}

// Draw boxes on the page (coordinates are 0-1000 normalized)
function drawBoxes(
  boxes: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    label?: string;
  }>,
) {
  const container = getBoxContainer();
  container.innerHTML = "";

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  for (const box of boxes) {
    // Convert from 0-1000 normalized to viewport pixels
    const x1 = (box.x1 / 1000) * vw;
    const y1 = (box.y1 / 1000) * vh;
    const x2 = (box.x2 / 1000) * vw;
    const y2 = (box.y2 / 1000) * vh;

    const div = document.createElement("div");
    div.style.cssText = `
      position:absolute;
      left:${x1}px;
      top:${y1}px;
      width:${x2 - x1}px;
      height:${y2 - y1}px;
      border:2px solid #22c55e;
      background:rgba(34,197,94,0.1);
      pointer-events:none;
    `;

    if (box.label) {
      const label = document.createElement("span");
      label.textContent = box.label;
      label.style.cssText = `
        position:absolute;
        top:-18px;
        left:0;
        background:#22c55e;
        color:white;
        font-size:11px;
        padding:1px 4px;
        border-radius:2px;
        white-space:nowrap;
      `;
      div.appendChild(label);
    }

    container.appendChild(div);
  }
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "GET_VIEWPORT") {
    sendResponse({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    return false;
  }
  if (message.type === "DRAW_BOXES") {
    drawBoxes(message.boxes || []);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "CLEAR_BOXES") {
    clearBoxes();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
