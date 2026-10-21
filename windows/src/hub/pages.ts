// The Flow pages of the Coucou window, by id (shell.ts draws the Notch ones
// from the island's settings).

import type { FlowPageRenderer, PageId } from "./shell";
import { voicePage } from "./pages/voice";

export const FLOW_PAGE_RENDERERS: Partial<Record<PageId, FlowPageRenderer>> = {
  voice: voicePage,
};
