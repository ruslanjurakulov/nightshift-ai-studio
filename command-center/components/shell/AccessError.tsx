"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CloudOff, Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useSignOut } from "@/components/account/AccountParts";

/**
 * Shown in place of the whole app frame when the shell could not CHECK who may see what (the database did not answer
 * for the access lookup). It is not the customer shell and not an error page about the account: the owner's phone lost
 * the network for a second, and the honest thing to say is exactly that, with one button that asks again.
 * No operator page, link or figure is drawn here (fail closed).
 */
export function AccessError() {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const signOut = useSignOut();
  return (
    <main id="main" className="grid min-h-svh place-items-center px-4 py-10">
      <section role="alert" className="panel flex w-full max-w-md flex-col items-start gap-4 p-6" aria-labelledby="access-error-title">
        <CloudOff aria-hidden className="size-8 text-[var(--color-warn)]" />
        <h1 id="access-error-title" className="text-xl font-semibold">
          {t.ownerTruth.accessErrorTitle}
        </h1>
        <p className="text-[var(--color-muted)]">{t.ownerTruth.accessErrorBody}</p>
        <button type="button" className="btn-primary" disabled={pending} aria-busy={pending} onClick={() => start(() => router.refresh())}>
          {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden className="size-4" />}
          {pending ? t.ownerTruth.accessErrorWorking : t.ownerTruth.accessErrorRetry}
        </button>
        {/* A way out that needs no database: the session is this browser's to end. */}
        <button type="button" className="btn-quiet" onClick={() => void signOut()}>
          {t.common.signOut}
        </button>
      </section>
    </main>
  );
}
