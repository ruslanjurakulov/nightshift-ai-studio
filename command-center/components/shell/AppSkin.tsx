"use client";

import { useEffect } from "react";
import { DS_SKIN_CLASS } from "@/lib/skin";

/**
 * Keeps <html class="ds-skin"> true to the layout on screen across client navigation. The root layout sets the class from
 * the request (lib/skin.ts), but a soft navigation does not re-render the root layout: a signed-in user who follows a link
 * from /pricing into the app would keep the public look, and one who leaves the app for /pricing would carry the navy one
 * there. Mounted only by the signed-in layouts, so being on screen IS the answer; no URL is read here.
 */
export function AppSkin() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(DS_SKIN_CLASS);
    return () => root.classList.remove(DS_SKIN_CLASS);
  }, []);
  return null;
}
