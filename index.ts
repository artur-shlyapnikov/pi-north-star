import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import startExtension from "./src/extension/index";
export default function (pi: ExtensionAPI): void {
    startExtension(pi);
}
