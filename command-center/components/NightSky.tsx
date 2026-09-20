"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * The brand's backdrop: a starfield in real perspective, flying slowly toward
 * the viewer. Each star carries a z, is projected through a focal length, and
 * gains size and brightness as it approaches — so the depth is actual
 * projection rather than three layers pretending. It is Nightshift's own image,
 * drawn in the accent so it belongs to this palette and no other.
 *
 * Opening a section surges the flight forward and eases it back, which is what
 * ties the backdrop to navigation instead of leaving it as wallpaper.
 *
 * It sits at z-index 0 rather than behind everything: a negative z-index would
 * put it under the body's own opaque background, where it draws perfectly and
 * is never seen. The shell above it carries z-10.
 *
 * Deliberately cheap, because it sits under a screen someone reads all day: one
 * 2D canvas, a fixed pool of stars, no allocation per frame, no WebGL. It stops
 * entirely when the tab is hidden, and under prefers-reduced-motion it draws a
 * single still frame and never animates.
 */

const COUNT = 420;
const FOCAL = 420; // perspective strength
const DEPTH = 1400; // how far back stars are seeded
const BASE_SPEED = 0.55;

type Star = { x: number; y: number; z: number; s: number };

// A slow-drifting volumetric glow — the deep-space colour the stars fly through.
// Each blob orbits a home point on its own phase, so the field breathes without
// ever repeating. Drawn additively under the stars, in the one accent hue.
type Nebula = { hx: number; hy: number; r: number; a: number; hue: string; ph: number; sp: number; rad: number };
// A rare streak that crosses the frame and fades — life runs 1 → 0.
type Shoot = { x: number; y: number; vx: number; vy: number; len: number; life: number };

export function NightSky() {
  const ref = useRef<HTMLCanvasElement>(null);
  const pathname = usePathname();
  // The loop reads this; navigation never rebuilds the field.
  const surge = useRef(0);

  useEffect(() => {
    surge.current = 1;
  }, [pathname]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    let raf = 0;
    let running = true;
    let t = 0; // frame clock, drives the nebula drift
    const stars: Star[] = [];
    const nebulae: Nebula[] = [];
    const shooting: Shoot[] = [];

    // The accent sky-blue the palette is built on, plus a cooler step and two
    // restrained neighbours — a teal and a soft violet — so the void has real
    // colour and depth rather than one flat wash. Still all low-saturation and
    // low-alpha, blended additively, so nothing shouts over the data.
    const NEB_HUES = ["161,208,252", "124,182,238", "120,214,226", "150,150,246"];

    function seedNebulae() {
      nebulae.length = 0;
      const homes = [
        [0.14, 0.10], [0.86, 0.06], [0.5, 0.64], [0.20, 0.88], [0.92, 0.74], [0.62, 0.24],
      ];
      homes.forEach(([fx, fy], i) => {
        nebulae.push({
          hx: fx * w, hy: fy * h,
          rad: Math.max(w, h) * (0.26 + Math.random() * 0.2),
          r: 0, a: 0.08 + Math.random() * 0.055,
          hue: NEB_HUES[i % NEB_HUES.length],
          ph: Math.random() * Math.PI * 2,
          sp: 0.0009 + Math.random() * 0.0012,
        });
      });
    }

    // A wide aurora band that drifts slowly across the upper third — the single
    // brightest sweep, so the frame has a light source the nebulae orbit.
    function drawAurora() {
      const cyA = h * (0.22 + Math.sin(t * 0.0006) * 0.05);
      const band = h * 0.5;
      const g = ctx!.createLinearGradient(0, cyA - band, 0, cyA + band);
      g.addColorStop(0, "rgba(161,208,252,0)");
      g.addColorStop(0.5, `rgba(161,208,252,${0.05 + Math.sin(t * 0.0009) * 0.015})`);
      g.addColorStop(1, "rgba(124,182,238,0)");
      ctx!.fillStyle = g;
      const skew = Math.sin(t * 0.0007) * w * 0.12;
      ctx!.save();
      ctx!.translate(skew, 0);
      ctx!.fillRect(-w * 0.3, cyA - band, w * 1.6, band * 2);
      ctx!.restore();
    }

    const respawn = (st: Star, fresh: boolean) => {
      // Seeded across a wide box so the field still fills the frame at the edges.
      st.x = (Math.random() - 0.5) * w * 2.4;
      st.y = (Math.random() - 0.5) * h * 2.4;
      st.z = fresh ? Math.random() * DEPTH + 1 : DEPTH;
      st.s = 0.5 + Math.random() * 1.3;
    };

    function build() {
      stars.length = 0;
      for (let i = 0; i < COUNT; i++) {
        const st: Star = { x: 0, y: 0, z: 0, s: 1 };
        respawn(st, true);
        stars.push(st);
      }
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas!.clientWidth;
      h = canvas!.clientHeight;
      cx = w / 2;
      cy = h / 2;
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
      seedNebulae();
    }

    // The volumetric glow, drawn first and blended additively so overlaps bloom
    // instead of banding. It drifts on a slow sine so the field is never static.
    function drawNebulae() {
      ctx!.globalCompositeOperation = "lighter";
      drawAurora();
      for (const n of nebulae) {
        const dx = Math.cos(n.ph + t * n.sp) * w * 0.05;
        const dy = Math.sin(n.ph * 1.3 + t * n.sp) * h * 0.05;
        const cxN = n.hx + dx;
        const cyN = n.hy + dy;
        const g = ctx!.createRadialGradient(cxN, cyN, 0, cxN, cyN, n.rad);
        g.addColorStop(0, `rgba(${n.hue},${n.a})`);
        g.addColorStop(0.5, `rgba(${n.hue},${n.a * 0.35})`);
        g.addColorStop(1, `rgba(${n.hue},0)`);
        ctx!.fillStyle = g;
        ctx!.fillRect(cxN - n.rad, cyN - n.rad, n.rad * 2, n.rad * 2);
      }
      ctx!.globalCompositeOperation = "source-over";
    }

    // A rare streak. Spawns from a random top edge point, crosses down and out,
    // and fades. At most a couple alive at once; low spawn odds keep it a treat.
    function spawnShoot() {
      shooting.push({
        x: Math.random() * w * 0.9,
        y: Math.random() * h * 0.3,
        vx: 5 + Math.random() * 4,
        vy: 2.4 + Math.random() * 2.2,
        len: 90 + Math.random() * 70,
        life: 1,
      });
    }
    function drawShooting() {
      if (!reduced && shooting.length < 2 && Math.random() < 0.004) spawnShoot();
      for (let i = shooting.length - 1; i >= 0; i--) {
        const s = shooting[i];
        if (!reduced) { s.x += s.vx; s.y += s.vy; s.life -= 0.012; }
        if (s.life <= 0 || s.x > w + 120 || s.y > h + 120) { shooting.splice(i, 1); continue; }
        const tailX = s.x - s.vx * (s.len / 7);
        const tailY = s.y - s.vy * (s.len / 7);
        const g = ctx!.createLinearGradient(s.x, s.y, tailX, tailY);
        g.addColorStop(0, `rgba(220,238,255,${0.9 * s.life})`);
        g.addColorStop(1, "rgba(161,208,252,0)");
        ctx!.strokeStyle = g;
        ctx!.lineWidth = 2;
        ctx!.lineCap = "round";
        ctx!.beginPath();
        ctx!.moveTo(s.x, s.y);
        ctx!.lineTo(tailX, tailY);
        ctx!.stroke();
      }
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h);
      t += 1;

      drawNebulae();

      const speed = BASE_SPEED * (1 + surge.current * 9);
      for (const st of stars) {
        if (!reduced) {
          st.z -= speed;
          if (st.z < 1) respawn(st, false);
        }
        const k = FOCAL / st.z;
        const px = cx + st.x * k;
        const py = cy + st.y * k;
        if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;

        // Nearer is bigger and brighter — the whole cue that this has depth.
        // A real floor on brightness: a far star must still be a star, not a
        // pixel at 6% that no screen shows. Near ones then pull clearly ahead.
        const near = 1 - st.z / DEPTH;
        const r = Math.max(0.65, st.s * k * 1.7);
        ctx!.globalAlpha = Math.min(0.9, 0.2 + near * 0.7);
        ctx!.fillStyle = "#a1d0fc";
        ctx!.beginPath();
        ctx!.arc(px, py, Math.min(r, 2.6), 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;

      drawShooting();

      if (surge.current > 0) surge.current = Math.max(0, surge.current - 0.014);
    }

    function frame() {
      if (!running) return;
      draw();
      raf = requestAnimationFrame(frame);
    }

    function onVisibility() {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reduced) {
        running = true;
        raf = requestAnimationFrame(frame);
      }
    }

    resize();
    if (reduced) {
      draw();
    } else {
      raf = requestAnimationFrame(frame);
    }
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
    />
  );
}
