/**
 * Small platform marks for Instagram, TikTok and YouTube — simple inline SVG
 * glyphs (no remote assets, no brand files), sized by the caller.
 */
export type LogoPlatform = "instagram" | "tiktok" | "youtube";

export function PlatformLogo({ platform, size = 18 }: { platform: LogoPlatform; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true } as const;
  if (platform === "instagram") {
    return (
      <svg {...common} fill="none" stroke="#E1306C" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="0.8" fill="#E1306C" stroke="none" />
      </svg>
    );
  }
  if (platform === "tiktok") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M16.6 3c.3 2.1 1.6 3.6 3.9 3.8v3a7.3 7.3 0 0 1-3.8-1.1v6.1a5.8 5.8 0 1 1-5.8-5.8c.3 0 .6 0 .9.1v3.1a2.8 2.8 0 1 0 1.9 2.6V3h2.9z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2" y="5" width="20" height="14" rx="4" fill="#FF0000" />
      <path d="M10 9v6l5-3z" fill="#fff" />
    </svg>
  );
}
