import { render } from "preact";
import { ChatOverlay } from "../overlay/ChatOverlay";

render(<ChatOverlay defaultOpen draggable={false} />, document.getElementById("root")!);
