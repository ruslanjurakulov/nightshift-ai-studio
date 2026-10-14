import type { Metadata } from "next";
import Link from "next/link";
import { getDictionaryFor, isLocale, type Locale } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { AuthShell } from "@/components/auth/AuthShell";
import { isUnsubscribeScope, isUnsubscribeToken, type UnsubscribeScope } from "@/lib/email-prefs";

export const dynamic = "force-dynamic";

/** The end of an e-mail link: not for search engines, and never cached. */
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

type Params = { t?: string | string[]; s?: string | string[]; l?: string | string[]; d?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * "Stop these e-mails": where the link in a mail lands (migration 0103). No
 * sign-in: the long random token in the address is the authority, and a GET
 * changes nothing (mail scanners open links). The button posts to
 * /api/email/unsubscribe, which turns the mail off and comes back here with
 * `d=1` (done) or `d=0` (that link does not work). The token is not carried
 * back: the finished page has none to leak.
 *
 * The language is the one the mail was written in (`l`), when this build has it,
 * else the visitor's own.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const asked = one(q.l);
  const locale: Locale = isLocale(asked) ? asked : await getLocale();
  const dict = getDictionaryFor(locale);
  const u = dict.unsubscribe;
  const scopeRaw = one(q.s);
  const scope: UnsubscribeScope = isUnsubscribeScope(scopeRaw) ? scopeRaw : "ready";
  const token = one(q.t);
  const done = one(q.d);

  const state: "confirm" | "done" | "invalid" =
    done === "1" ? "done" : done === "0" ? "invalid" : isUnsubscribeToken(token) ? "confirm" : "invalid";
  const action = `/api/email/unsubscribe?${new URLSearchParams({ t: token ?? "", s: scope, l: locale }).toString()}`;
  const body = scope === "weekly" ? u.confirmWeekly : scope === "all" ? u.confirmAll : u.confirmReady;

  return (
    <PublicI18nProvider locale={locale} t={publicDictionary(dict)}>
      <AuthShell title={state === "done" ? u.doneTitle : state === "invalid" ? u.invalidTitle : u.title} mode="signin">
        <p className="st-body mt-4 text-[var(--ns-text)]">{state === "done" ? u.doneBody : state === "invalid" ? u.invalidBody : body}</p>
        <div className="mt-8 flex flex-col gap-3">
          {state === "confirm" ? (
            <form method="post" action={action}>
              <button type="submit" className="st-key" data-block="true">
                {u.button}
              </button>
            </form>
          ) : (
            <Link href="/" className="st-key" data-block="true">
              {u.openApp}
            </Link>
          )}
        </div>
      </AuthShell>
    </PublicI18nProvider>
  );
}
