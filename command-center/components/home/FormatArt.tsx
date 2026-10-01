import type { HomeFormatId } from "@/lib/home";

/**
 * The format cards' tiles: drawn, not generated. A picture of a person here
 * would read as "this is what you will get", and nothing here was made by the
 * pipeline — so each format is a small illustration of its idea instead.
 * Decorative only (aria-hidden); the card's title says what it is.
 * Same artwork in both themes: it sits on its own painted ground.
 */
export function FormatArt({ id, className = "" }: { id: HomeFormatId; className?: string }) {
  return (
    <svg
      viewBox="0 0 160 100"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {ART[id]}
    </svg>
  );
}

const ART: Record<HomeFormatId, React.ReactNode> = {
  story: (
    <>
      <defs>
        <linearGradient id="fa-story-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b1f4b" />
          <stop offset="1" stopColor="#6b4fa8" />
        </linearGradient>
      </defs>
      <rect width="160" height="100" fill="url(#fa-story-sky)" />
      <circle cx="118" cy="26" r="12" fill="#ffe7b0" />
      <circle cx="123" cy="22" r="11" fill="#2a2a62" opacity="0.9" />
      {[
        [20, 18],
        [44, 30],
        [70, 12],
        [92, 34],
        [142, 46],
        [30, 44],
      ].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" fill="#fff" opacity="0.85" />
      ))}
      <path d="M0 78 L34 50 L58 68 L88 40 L122 70 L160 52 L160 100 L0 100 Z" fill="#3a2e74" />
      <path d="M0 88 L28 72 L64 86 L104 66 L160 84 L160 100 L0 100 Z" fill="#221a4d" />
      <path d="M78 100 C 82 92, 70 88, 80 80" stroke="#ffe7b0" strokeWidth="1.4" fill="none" opacity="0.7" />
    </>
  ),
  kids: (
    <>
      <defs>
        <linearGradient id="fa-kids-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd3a5" />
          <stop offset="1" stopColor="#fd9fb7" />
        </linearGradient>
      </defs>
      <rect width="160" height="100" fill="url(#fa-kids-sky)" />
      <circle cx="34" cy="28" r="11" fill="#fff4b8" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line
          key={a}
          x1={34 + Math.cos((a * Math.PI) / 180) * 15}
          y1={28 + Math.sin((a * Math.PI) / 180) * 15}
          x2={34 + Math.cos((a * Math.PI) / 180) * 19}
          y2={28 + Math.sin((a * Math.PI) / 180) * 19}
          stroke="#fff4b8"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ))}
      <g fill="#ffffff" opacity="0.9">
        <circle cx="104" cy="24" r="7" />
        <circle cx="113" cy="21" r="9" />
        <circle cx="123" cy="25" r="6.5" />
        <rect x="104" y="24" width="20" height="7" />
      </g>
      <ellipse cx="40" cy="104" rx="70" ry="30" fill="#7fd1a1" />
      <ellipse cx="128" cy="108" rx="64" ry="32" fill="#5cbf8a" />
      <line x1="132" y1="44" x2="128" y2="70" stroke="#ffffff" strokeWidth="0.8" opacity="0.8" />
      <ellipse cx="133" cy="38" rx="7" ry="9" fill="#ff6b8b" />
    </>
  ),
  explainer: (
    <>
      <defs>
        <linearGradient id="fa-exp-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0f5e7a" />
          <stop offset="1" stopColor="#2e8fd6" />
        </linearGradient>
      </defs>
      <rect width="160" height="100" fill="url(#fa-exp-bg)" />
      <g stroke="#ffffff" strokeOpacity="0.12" strokeWidth="0.6">
        {[20, 40, 60, 80, 100, 120, 140].map((x) => (
          <line key={`v${x}`} x1={x} y1="0" x2={x} y2="100" />
        ))}
        {[20, 40, 60, 80].map((y) => (
          <line key={`h${y}`} x1="0" y1={y} x2="160" y2={y} />
        ))}
      </g>
      <polyline
        points="18,78 46,62 72,68 98,42 128,30"
        fill="none"
        stroke="#b9f3ff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {[
        [18, 78],
        [46, 62],
        [72, 68],
        [98, 42],
        [128, 30],
      ].map(([x, y]) => (
        <circle key={`${x}`} cx={x} cy={y} r="3.2" fill="#0f5e7a" stroke="#b9f3ff" strokeWidth="1.8" />
      ))}
      <rect x="112" y="58" width="32" height="24" rx="4" fill="#ffffff" opacity="0.16" />
      <rect x="117" y="64" width="18" height="2.4" rx="1.2" fill="#ffffff" opacity="0.8" />
      <rect x="117" y="70" width="22" height="2.4" rx="1.2" fill="#ffffff" opacity="0.5" />
    </>
  ),
  interview: (
    <>
      <defs>
        <linearGradient id="fa-int-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f2a65a" />
          <stop offset="1" stopColor="#c8507a" />
        </linearGradient>
      </defs>
      <rect width="160" height="100" fill="url(#fa-int-bg)" />
      <path d="M22 22 h58 a8 8 0 0 1 8 8 v20 a8 8 0 0 1 -8 8 h-40 l-12 10 v-10 h-6 a8 8 0 0 1 -8 -8 v-20 a8 8 0 0 1 8 -8 z" fill="#ffffff" opacity="0.92" />
      <rect x="30" y="32" width="40" height="3" rx="1.5" fill="#c8507a" opacity="0.6" />
      <rect x="30" y="40" width="30" height="3" rx="1.5" fill="#c8507a" opacity="0.4" />
      <path d="M138 44 h-50 a8 8 0 0 0 -8 8 v18 a8 8 0 0 0 8 8 h34 l12 10 v-10 h4 a8 8 0 0 0 8 -8 v-18 a8 8 0 0 0 -8 -8 z" fill="#3b1730" opacity="0.55" />
      <rect x="90" y="54" width="36" height="3" rx="1.5" fill="#ffffff" opacity="0.75" />
      <rect x="90" y="62" width="26" height="3" rx="1.5" fill="#ffffff" opacity="0.5" />
    </>
  ),
  drama: (
    <>
      <defs>
        <linearGradient id="fa-dr-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#240a14" />
          <stop offset="1" stopColor="#4a1024" />
        </linearGradient>
        <linearGradient id="fa-dr-beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe6c4" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffe6c4" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <rect width="160" height="100" fill="url(#fa-dr-bg)" />
      <path d="M80 0 L56 100 L104 100 Z" fill="url(#fa-dr-beam)" />
      <ellipse cx="80" cy="92" rx="26" ry="5" fill="#ffe6c4" opacity="0.25" />
      <g fill="#120409">
        <circle cx="72" cy="62" r="5" />
        <path d="M65 92 q7 -26 14 0 z" />
        <circle cx="89" cy="64" r="4.6" />
        <path d="M83 92 q6 -24 12 0 z" />
      </g>
      <path d="M0 0 h34 c-6 30 -2 70 6 100 h-40 z" fill="#a3163c" />
      <path d="M160 0 h-34 c6 30 2 70 -6 100 h40 z" fill="#a3163c" />
      <path d="M0 0 h160 v8 c-20 6 -40 6 -80 4 c-40 2 -60 2 -80 -4 z" fill="#c81f4b" />
    </>
  ),
  shorts: (
    <>
      <defs>
        <linearGradient id="fa-sh-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b3cc4" />
          <stop offset="1" stopColor="#e2559f" />
        </linearGradient>
      </defs>
      <rect width="160" height="100" fill="url(#fa-sh-bg)" />
      <rect x="62" y="8" width="36" height="84" rx="7" fill="#140b2e" opacity="0.85" />
      <rect x="66" y="13" width="28" height="74" rx="4" fill="#ffffff" opacity="0.12" />
      <path d="M76 42 L88 50 L76 58 Z" fill="#ffffff" />
      <rect x="69" y="80" width="22" height="2" rx="1" fill="#ffffff" opacity="0.35" />
      <rect x="69" y="80" width="13" height="2" rx="1" fill="#ffffff" />
      <circle cx="30" cy="30" r="3" fill="#ffffff" opacity="0.5" />
      <circle cx="130" cy="70" r="4" fill="#ffffff" opacity="0.35" />
      <path d="M118 22 l4 -8 l4 8 l-4 8 z" fill="#ffffff" opacity="0.6" />
    </>
  ),
};
