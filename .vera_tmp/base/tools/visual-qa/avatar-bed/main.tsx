/**
 * A tiny page that mounts the profile-photo components for the visual QA
 * (run.mjs). It lives in tools/, not in app/, so it ships in no bundle and no
 * route exists for it in the product. next/navigation and the Supabase browser
 * client are replaced by stubs (see run.mjs); everything else is the real code.
 *
 *   ?scene=avatars              every Avatar size, letter and photo, ring or not
 *   ?scene=uploader[&photo=1]   AvatarUploader, with or without a current photo
 *   &theme=light|dark  &locale=en|ru|uz
 */
import { createRoot } from "react-dom/client";
import "../../../command-center/app/fonts.css";
import "../../../command-center/app/globals.css";
import "../../../command-center/app/(app)/app-pages-g5.css";
import { I18nProvider } from "@/lib/i18n/context";
import { ToastProvider } from "@/components/feedback/ToastProvider";
import { Avatar } from "@/components/account/Avatar";
import { AvatarUploader } from "@/components/account/AvatarUploader";
import { AVATAR_SIZES } from "@/lib/avatar";
import type { Locale } from "@/lib/i18n";

const q = new URLSearchParams(location.search);
const theme = q.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
const locale = (["en", "ru", "uz"].includes(q.get("locale") ?? "") ? q.get("locale") : "en") as Locale;
document.documentElement.lang = locale;
const scene = q.get("scene") ?? "avatars";
const EMAIL = "ruslan@example.com";
const VERSION = 1760000000000;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-4 py-3">
      <span className="w-40 text-sm text-[var(--color-muted)]">{label}</span>
      <div className="flex flex-wrap items-center gap-4">{children}</div>
    </div>
  );
}

function Avatars() {
  return (
    <section aria-label="Avatars" className="flex flex-col divide-y divide-[var(--color-border)]">
      <h1 className="g5-h pb-3">Avatar</h1>
      <Row label="Letter">
        {AVATAR_SIZES.map((s) => (
          <Avatar key={s} email={EMAIL} size={s} />
        ))}
      </Row>
      <Row label="Letter, ring">
        {AVATAR_SIZES.map((s) => (
          <Avatar key={s} email={EMAIL} size={s} ring />
        ))}
      </Row>
      <Row label="Photo">
        {AVATAR_SIZES.map((s) => (
          <Avatar key={s} email={EMAIL} version={VERSION} size={s} />
        ))}
      </Row>
      <Row label="Photo, ring">
        {AVATAR_SIZES.map((s) => (
          <Avatar key={s} email={EMAIL} version={VERSION} size={s} ring />
        ))}
      </Row>
      <Row label="No letter (icon)">
        {AVATAR_SIZES.map((s) => (
          <Avatar key={s} email={null} size={s} ring />
        ))}
      </Row>
      <Row label="Photo fails to load">
        {AVATAR_SIZES.map((s) => (
          <Avatar key={s} email={EMAIL} version={999} size={s} ring />
        ))}
      </Row>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider locale={locale}>
    <ToastProvider>
      <main className="mx-auto w-full max-w-[44rem] px-4 py-8">
        {scene === "uploader" ? <AvatarUploader email={EMAIL} version={q.get("photo") === "1" ? VERSION : null} /> : <Avatars />}
      </main>
    </ToastProvider>
  </I18nProvider>,
);
