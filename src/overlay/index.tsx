import { render } from "preact";
import { ChatOverlay } from "./ChatOverlay";

const container = document.createElement("div");
container.id = "agent-overlay-root";

const shadow = container.attachShadow({ mode: "closed" });
shadow.innerHTML = `
  <link rel="stylesheet" href="${chrome.runtime.getURL("overlay.css")}" />
  <div id="mount"></div>
`;

document.body.appendChild(container);
render(<ChatOverlay />, shadow.getElementById("mount")!);

// Handle hide/show for screenshots
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "HIDE_OVERLAY" || message.type === "SHOW_OVERLAY") {
    container.style.display = message.type === "HIDE_OVERLAY" ? "none" : "";
  }
});
