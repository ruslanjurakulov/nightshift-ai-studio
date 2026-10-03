"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";

/** Toggles dashboard customize mode by broadcasting a window event that each
 *  Widget listens for — no context/prop threading, so server-rendered widget
 *  content still works. Layout choices persist per-device in localStorage. */
export function CustomizeButton() {
  const { t } = useI18n();
  const [on, setOn] = useState(false);

  function toggle() {
    const next = !on;
    setOn(next);
    window.dispatchEvent(new CustomEvent("chronos:customize", { detail: { on: next } }));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="btn-quiet text-sm font-normal"
    >
      {on ? t.ops.customizeDone : t.ops.customize}
    </button>
  );
}
