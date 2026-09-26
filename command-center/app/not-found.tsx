import type { Metadata } from "next";
import Link from "next/link";
import { Compass } from "lucide-react";
import { PublicShell } from "@/components/legal/PublicShell";
import { getDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return { title: `${t.ux.notFoundTitle} · ${t.brand.name}` };
}

/**
 * Any URL that matches no route. "/" is the way back for everyone: it sends a
 * signed-in visitor to the dashboard they last used, and shows a signed-out
 * one the landing page.
 */
export default async function NotFound() {
  const { t } = await getDictionary();
  return (
    <PublicShell t={t}>
      <div className="mx-auto flex w-full max-w-lg min-h-[60vh] flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <span
          aria-hidden
          className="grid size-12 place-items-center rounded-full border border-[var(--color-border)] text-[var(--color-primary)]"
        >
          <Compass className="size-5" />
        </span>
        <p className="mono text-[12px] tracking-[0.3em] text-[var(--color-muted)]">404</p>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">{t.ux.notFoundTitle}</h1>
        <p className="text-[14px] leading-relaxed text-[var(--color-muted)]">{t.ux.notFoundBody}</p>
        <Link href="/" className="btn-sky is-solid pill mt-2 px-5 py-2 text-[13px]">
          {t.ux.notFoundHome}
        </Link>
      </div>
    </PublicShell>
  );
}
