import type { Dictionary } from "@/lib/i18n";
import { SOCIAL } from "@/lib/site/social";

/** Simple 24px glyphs in currentColor, keyed by `icon` in lib/site/social.ts: inline, so the CSP has nothing to allow. */
export const ICONS: Record<string, React.ReactNode> = {
  telegram: <path d="M21.4 4.1 2.9 11.2c-1.3.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.9.8s.7-.2 1-.5l2.3-2.3 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.5-1.4Zm-3.6 3.5-8.2 7.4-.3 3.2-1.5-4.8 10-5.8Z" />,
  instagram: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17.2" cy="6.8" r="1.2" />
    </>
  ),
};

/** The platforms under the footer's brand block: icon buttons, each at least 44 x 44, wrapping onto a second row when they run out of width. */
export function SocialIcons({ t }: { t: Dictionary }) {
  const f = t.site.footer;
  return (
    <nav className="st-social" aria-label={f.social}>
      {SOCIAL.map((s) => (
        <a key={s.id} href={s.href} target="_blank" rel="noopener noreferrer" aria-label={f[s.label]} title={f[s.label]}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true" focusable="false">
            {ICONS[s.icon]}
          </svg>
        </a>
      ))}
    </nav>
  );
}
