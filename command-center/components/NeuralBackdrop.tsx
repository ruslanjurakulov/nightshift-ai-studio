"use client";

import { useEffect, useRef } from "react";

/**
 * The MotionSites "Neural Pathway" backdrop, adopted app-wide: a silent, looping
 * light-painting behind every screen, under the veil that keeps type legible over
 * it. Frosted panels let the footage glow through them.
 *
 * The artwork is a video, so reduced motion is honoured in JS by pausing it — it
 * then holds its first frame (the still the loop was built from). muted +
 * playsInline are what make autoplay legal on iOS/Android.
 *
 * On data-dense screens pass `dim`, which lays a second scrim over the footage so
 * columns of numbers stay crisp; the hero (login) uses the lighter default.
 */
const POSTER =
  "https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/130837c4-0244-4f37-9c61-8d801d93fd29.jpg";
const SRC =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260912_104303_0c6d60b2-9353-408e-9449-585108a22fb5.mp4";

export function NeuralBackdrop({ dim = false }: { dim?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const q = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const v = ref.current;
    if (!q || !v) return;
    function sync() {
      if (q!.matches) {
        v!.pause();
      } else {
        const p = v!.play();
        if (p) p.catch(() => {});
      }
    }
    sync();
    if (q.addEventListener) q.addEventListener("change", sync);
    else q.addListener(sync);
    return () => {
      if (q.removeEventListener) q.removeEventListener("change", sync);
      else q.removeListener(sync);
    };
  }, []);

  return (
    <>
      <video
        ref={ref}
        className="pointer-events-none fixed inset-0 z-0 h-full w-full object-cover"
        style={{ background: "#03060c" }}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden
        poster={POSTER}
        src={SRC}
      />
      <div className="veil-neural" aria-hidden />
      {dim && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-0"
          style={{ background: "rgba(3, 6, 12, 0.46)" }}
        />
      )}
    </>
  );
}
