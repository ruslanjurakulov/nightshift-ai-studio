import { createContext } from "react";

/**
 * Whether the Studio canvas is the thing on screen. The Studio's Plan column keeps the person's canvas mounted under the plan, so
 * nothing on it is lost (components/studio-live/PlanColumn.tsx); while it is hidden it must not act. `inert` does not reach what the
 * canvas draws outside its own box (its bar in the app header, the palette, quick-add, inspector and drawer portaled to <body>), so
 * the canvas reads this and stops itself. True everywhere no provider says otherwise.
 */
export const CanvasActiveContext = createContext(true);
