/**
 * Content script - provides viewport info and draws box overlays
 */

// Container for box overlays
let boxContainer: HTMLDivElement | null = null;

function getBoxContainer(): HTMLDivElement {
  if (!boxContainer) {
    boxContainer = document.createElement("div");
    boxContainer.id = "agent-box-container";
    document.body.appendChild(boxContainer);
  }
  return boxContainer;
}

function clearBoxes() {
  if (boxContainer) {
    boxContainer.innerHTML = "";
  }
}

function createBoxElement(
  box: { x1: number; y1: number; x2: number; y2: number; label?: string },
  vw: number,
  vh: number,
): HTMLDivElement {
  const x1 = (box.x1 / 1000) * vw;
  const y1 = (box.y1 / 1000) * vh;
  const x2 = (box.x2 / 1000) * vw;
  const y2 = (box.y2 / 1000) * vh;

  const div = document.createElement("div");
  div.className = "agent-box";
  div.style.left = `${x1}px`;
  div.style.top = `${y1}px`;
  div.style.width = `${x2 - x1}px`;
  div.style.height = `${y2 - y1}px`;

  if (box.label) {
    const label = document.createElement("span");
    label.className = "agent-box-label";
    label.textContent = box.label;
    div.appendChild(label);
  }

  return div;
}

function addBoxes(boxes: Array<{ x1: number; y1: number; x2: number; y2: number; label?: string }>) {
  const container = getBoxContainer();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  for (const box of boxes) {
    container.appendChild(createBoxElement(box, vw, vh));
  }
}

function flashClick(x: number, y: number) {
  const dot = document.createElement("div");
  dot.className = "agent-flash";
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  document.body.appendChild(dot);
  setTimeout(() => dot.remove(), 600);
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
  if (message.type === "ADD_BOXES") {
    addBoxes(message.boxes || []);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "FLASH_CLICK") {
    flashClick(message.x, message.y);
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
