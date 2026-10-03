"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** The words a copy button needs, in the page's language. */
export type CopyLabels = {
  copy: string;
  copied: string;
  /** "Copy {name}": what a screen reader hears; `{name}` is the block's name. */
  copyName: string;
  copyFailed: string;
};

/**
 * Copies a snippet to the clipboard. The clipboard API needs a secure context
 * and a user gesture; where it is refused (an older browser, an embedded
 * view) a hidden textarea and execCommand are the fallback, and when that
 * fails too the button says so rather than claiming a copy that did not
 * happen. The state is announced politely, once.
 */
export function CopyButton({ text, name, labels }: { text: string; name: string; labels: CopyLabels }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2200);
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        className="st-copy"
        data-state={state}
        aria-label={labels.copyName.replace("{name}", name)}
      >
        {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span>{state === "copied" ? labels.copied : labels.copy}</span>
      </button>
      <span role="status" className="sr-only">
        {state === "copied" ? labels.copied : state === "failed" ? labels.copyFailed : ""}
      </span>
    </>
  );
}

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
