import { render } from "preact";
import { ChatOverlay } from "../overlay/ChatOverlay";

render(<ChatOverlay defaultOpen />, document.getElementById("root")!);
