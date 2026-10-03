import type { ReactNode } from "react";
import { Check } from "lucide-react";
import "@/components/create/flow.css";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { fmt } from "@/lib/i18n/core";
import { NotConfigured } from "@/components/NotConfigured";
import { AppName, withParts } from "@/components/oauth/AppName";
import { ConsentForm } from "@/components/oauth/ConsentForm";
import { OAuthNotice, OAuthShell } from "@/components/oauth/OAuthShell";
import { authorizeReturnPath, parseAuthorizeParams, redirectWith } from "@/lib/oauth/authorize";
import { describeRedirect, normalizeResource } from "@/lib/oauth/redirect";
import { hashSecret, newRequestSecret } from "@/lib/oauth/tokens";
import { beginAuthorization, oauthDeps } from "@/lib/server/oauth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Raw = Record<string, string | string[] | undefined>;

/**
 * /oauth/authorize — where a person decides whether an AI app may use their
 * workspace (migration 0093; the MCP authorization spec, lib/oauth/config.ts).
 *
 * In order: sign-in (a signed-out visitor goes to /login and comes back to this
 * exact request); the app and its return address are checked by the database
 * against what the app registered, EXACTLY — until they match nothing is ever
 * redirected anywhere, the person just sees an error page; a Free workspace is
 * told it needs a paid plan and no request is made at all (so no code can ever
 * exist for it); otherwise the consent screen, which names the app as it
 * registered itself TOGETHER WITH the host it will send the person back to (so
 * a lookalike name is visible), the workspace, the exact permissions and a
 * mandatory monthly spending limit. The screen's Allow/Deny posts to
 * /oauth/decision with a single-use secret made here, for this person.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Raw> }) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const raw = await searchParams;
  const { t, locale } = await getDictionary();
  const o = t.oauth;

  const user = await getUser();
  if (!user) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(raw)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one);
    redirect(`/login?next=${encodeURIComponent(authorizeReturnPath(q.toString()))}`);
  }

  const failure = (title: string, body: ReactNode, action?: { href: string; label: string }) => (
    <OAuthShell title={title}>
      <OAuthNotice tone="warn">{body}</OAuthNotice>
      {action && (
        <p className="mt-6">
          <Link href={action.href} className="st-key" data-block="true">
            {action.label}
          </Link>
        </p>
      )}
    </OAuthShell>
  );

  const parsed = parseAuthorizeParams(raw);
  if (!parsed.ok) return failure(o.errorTitle, o.errorBody);
  const p = parsed.params;
  const deps = oauthDeps();

  // What is wrong with the request itself (not the app's identity) is only
  // reported to the app AFTER the database has confirmed its return address.
  const resource = normalizeResource(p.resource, deps.resource);
  const secret = newRequestSecret();
  const preFailed = p.responseType !== "code" || resource === null;
  const view = await beginAuthorization({
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    method: preFailed ? "" : p.codeChallengeMethod,
    state: p.state,
    scope: p.scope,
    resource: preFailed ? "" : (resource as string),
    secretHash: await hashSecret(secret),
  });

  if (view === "unavailable") return failure(o.unavailableTitle, o.unavailableBody);
  if (!view.ok) {
    if (!view.redirectOk) return failure(o.errorTitle, o.errorBody);
    if (view.error === "no_workspace") return failure(o.noWorkspaceTitle, o.noWorkspaceBody, { href: "/welcome", label: o.finishSetup });
    // Each cause names itself: a wrong response_type is not a PKCE problem.
    const [error, description] =
      p.responseType !== "code"
        ? ["unsupported_response_type", "response_type must be code."]
        : resource === null
          ? ["invalid_target", `resource must be ${deps.resource}.`]
          : [view.error, view.description ?? "The request is not valid."];
    redirect(redirectWith(p.redirectUri, { error, error_description: description, state: p.state }, deps.origin));
  }
  if (!view.entitled) {
    return failure(o.needsPlanTitle, withParts(o.needsPlanBody, { app: <AppName name={view.clientName} />, workspace: <bdi className="font-semibold">{view.workspaceName}</bdi> }), {
      href: "/pricing",
      label: o.seePlans,
    });
  }

  const where = describeRedirect(view.redirectUri);
  const scopeText: Record<string, string> = { "videos:read": o.scopeRead, "videos:create": o.scopeCreate, "videos:publish": o.scopePublish };
  return (
    <OAuthShell title={withParts(o.title, { app: <AppName name={view.clientName} /> })}>
      <p className="st-body mt-3 [overflow-wrap:anywhere]">{withParts(o.lead, { app: <AppName name={view.clientName} /> })}</p>

      <div className="mt-6 flex flex-col gap-4">
        {/* Who is asking, and where this page will send the person: the two facts that expose a lookalike. */}
        <section className="fl-card" aria-label={o.sendsTo}>
          <dl className="flex flex-col gap-4">
            <div>
              <dt className="fl-hint">{o.sendsTo}</dt>
              <dd className="mt-1 break-all font-mono text-base font-semibold text-[var(--ns-text)]" dir="ltr">
                <bdi>{where.local ? `${o.localApp} (${where.host})` : where.host}</bdi>
              </dd>
            </div>
            <div>
              <dt className="fl-hint">{o.workspace}</dt>
              <dd className="mt-1 text-base font-semibold text-[var(--ns-text)] [overflow-wrap:anywhere]"><bdi>{view.workspaceName}</bdi></dd>
            </div>
          </dl>
          <p className="fl-hint">{o.checkAddress}</p>
          <p className="fl-hint">{o.nameNote}</p>
        </section>

        <section className="fl-card" aria-labelledby="oauth-can">
          <h2 id="oauth-can" className="fl-q">{o.canTitle}</h2>
          <ul className="flex flex-col gap-3">
            {view.scopes.map((s) => (
              <li key={s} className="flex items-start gap-3 text-base leading-snug">
                <Check aria-hidden className="mt-0.5 size-5 shrink-0 text-[var(--color-ok)]" />
                <span>{scopeText[s] ?? s}</span>
              </li>
            ))}
          </ul>
          <p className="fl-hint">
            <strong className="font-semibold text-[var(--ns-text)]">{o.cannotTitle}</strong> {o.cannot}
          </p>
        </section>

      <ConsentForm
        secret={secret}
        app={view.clientName}
        locale={locale}
        defaultLimit={view.defaultLimit}
        maxLimit={view.maxLimit}
        text={{
          limitLabel: o.limitLabel,
          limitHint: fmt(o.limitHint, { max: new Intl.NumberFormat(locale).format(view.maxLimit) }),
          limitInvalid: fmt(o.limitInvalid, { max: new Intl.NumberFormat(locale).format(view.maxLimit) }),
          limitEcho: o.limitEcho,
          limitEchoOne: o.limitEchoOne,
          limitEchoZero: o.limitEchoZero,
          allow: o.allow,
          deny: o.deny,
          working: o.working,
          failed: o.failed,
          expired: o.expired,
          sessionEnded: o.sessionEnded,
        }}
      />
      </div>
    </OAuthShell>
  );
}
