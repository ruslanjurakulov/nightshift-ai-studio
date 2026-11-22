import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SideNav } from "@/components/SideNav";
import { aiChatEnv, aiChatOpenFor } from "@/lib/brain/flag";
import { NeuralBackdrop } from "@/components/NeuralBackdrop";
import { Header } from "@/components/Header";
import { CommandPalette } from "@/components/CommandPalette";
import { getChannelContext } from "@/lib/channels-server";
import { getOrgContext } from "@/lib/orgs-server";
import { isSupabaseConfigured } from "@/lib/config";
import { WELCOME_PATH } from "@/lib/public-paths";
import { landingSection } from "@/lib/navigation";
import {
  ALL_CHANNELS,
  ALL_CHANNELS_SLUG,
  PATH_HEADER,
  SEARCH_HEADER,
  appRedirect,
  channelSlug,
  unscopedScope,
} from "@/lib/channels";
import { NavigationProvider } from "@/components/navigation/NavigationProvider";
import { ScrollToTop } from "@/components/navigation/ScrollToTop";
import { InstallHint } from "@/components/shell/InstallHint";
import { PendingSweep } from "@/components/shell/PendingSweep";
import { createClient, getUser } from "@/lib/supabase/server";
import { currentMfaAction, operatorLookup } from "@/lib/auth/org-roles";
import { AccessError } from "@/components/shell/AccessError";
import { SessionEndedBar } from "@/components/shell/SessionEndedBar";
import { AdminMfaBanner } from "@/components/security/AdminMfaBanner";
import { ENROL_PATH, isEnrolOnlyPath, mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { avatarVersionFromMetadata } from "@/lib/avatar";
import { readCreditAccount } from "@/lib/server/credits";
import { planValue, readBillingSummary } from "@/lib/server/plans";
import { accountPlan, type AccountPlan } from "@/lib/account";
import type { CreditAccount } from "@/lib/credits";
import { ShellProvider } from "@/components/shell/ShellContext";
import { readToolAvailability } from "@/lib/server/tool-availability";
import { GeoAttribution } from "@/components/legal/GeoAttribution";
import { SidebarProvider } from "@/components/shell/SidebarState";
import { SIDEBAR_COOKIE, isSidebarCollapsed } from "@/lib/sidebar-pref";
import { AppProviders } from "@/components/AppProviders";
import { getDictionary, getLocale } from "@/lib/i18n/server";
import { MotionProvider } from "@/components/motion/MotionProvider";
import { FlashNotice } from "@/components/account/FlashNotice";
import { SkipLink } from "@/components/shell/SkipLink";
import { adsFactoryEnabled } from "@/lib/adsFactory/flag";
import { characterStudioEnabled } from "@/lib/characterStudio/model";
import { likenessFeaturesAllowed } from "@/lib/likeness-policy";
import { filmStudioListed, filmStudioMode, filmStudioViewerOn } from "@/lib/server/films";
import { ShellOffsets } from "@/components/shell/ShellOffsets";
import { OWNER_MODE_COOKIE, ownerFrame } from "@/lib/owner-mode";
import { isPlatformOwner } from "@/lib/server/owner-view";
import { GlassPointer } from "@/components/ui/GlassPointer";
import "./app-redesign.css";
import "./app-pages-1.css";
// Last: the glass keys restate rules of the two files above at their own specificity, so they must follow them.
import "./app-glass.css";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // No backend means no account and nothing to show. A built site then answers
  // every app URL — /blog as much as /chronos/videos — with the public 404, so
  // a visitor never meets setup copy, env-var names or the app's frame. Only
  // `next dev` keeps the setup notice (NotConfigured), for whoever is wiring it up.
  if (!isSupabaseConfigured && process.env.NODE_ENV === "production") notFound();
  // Fail closed (BR-H-001). The middleware is the gate, but a request it never
  // sees (a matcher exclusion, a misconfigured edge) must not render the app
  // either: no session, no shell — before anything else is read or drawn. An
  // unreachable auth server also lands here as "no user", so it fails closed.
  const user = isSupabaseConfigured ? await getUser() : null;
  if (isSupabaseConfigured && !user) redirect("/login");

  const org = isSupabaseConfigured
    ? await getOrgContext()
    : { supported: false, orgs: [], switchable: [], current: null };

  // Signed in, organizations exist (0018 applied), and this account belongs to
  // none: a new sign-up. Nothing in the app would show them anything — RLS
  // returns no rows — so they are sent to first-run onboarding, which starts
  // with creating their organization.
  if (org.supported && org.orgs.length === 0) redirect(WELCOME_PATH);

  // Channels for the switcher. Empty before the Phase 5 migration is applied,
  // in which case the switcher renders nothing and the app looks as it did.
  const { channels, selection, slug: honest, scope } = isSupabaseConfigured
    ? await getChannelContext()
    : { channels: [], selection: ALL_CHANNELS, slug: ALL_CHANNELS_SLUG, scope: unscopedScope() };

  // Keep the address bar honest, in both directions. A URL naming a channel
  // that does not exist (deleted, mistyped, or not visible to this user) — or
  // that belongs to another organization, even one a platform admin can read —
  // resolves to every channel of the current organization, and says so. A URL naming the channel by its
  // internal id — /default/pipeline — resolves fine, and is rewritten to the
  // name the operator actually knows it by: /chronos/pipeline.
  //
  // And the app is one workspace for everyone but the platform operator: no
  // every-channel roll-up (their first channel instead), and no operator-only
  // section (their Command Center instead). See appRedirect in lib/channels.
  const lookup = await operatorLookup();
  const operator = lookup.operator;
  const headerStore = await headers();
  const path = headerStore.get(PATH_HEADER);
  // The access lookup itself failed (the database did not answer). That is not "this person is a customer": on a page
  // only an operator may open, or on the Command Center the owner lands on, say "can't reach the database, retry"
  // instead of silently redrawing the app as the customer frame. Still fail closed: nothing of the operator's is read
  // or drawn here, and a customer who hits the same blip on one of their own pages keeps their app.
  if (lookup.failed && !operator && path) {
    const base = { path, search: headerStore.get(SEARCH_HEADER) ?? "", honestSlug: honest, selection, channels };
    const operatorOnly = appRedirect({ ...base, operator: false }) !== appRedirect({ ...base, operator: true });
    const landing = path.split("/")[2] === landingSection(true);
    if (operatorOnly || landing) {
      return (
        <AppProviders locale={await getLocale()}>
          <AccessError />
        </AppProviders>
      );
    }
  }
  // The second factor (docs/security/ADMIN_MFA.md). The middleware has already
  // sent a password-only session that needs a code to /login/verify; this is the
  // same decision again for a request it did not see (lib/security/admin-mfa.ts
  // has the table and the lockout-safety rule). `warn_*` draws the banner below.
  const mfa = isSupabaseConfigured ? await currentMfaAction(user, operator) : "allow";
  if (mfa === "challenge") redirect(mfaVerifyUrl(path ? `${path}${headerStore.get(SEARCH_HEADER) ?? ""}` : undefined));
  // Strict `enforce`: an admin with no authenticator opens only /security. Only a path KNOWN to be elsewhere is
  // redirected (an unknown path is never a reason to loop), and the middleware already did the same for requests it saw.
  if (mfa === "enrol_only" && path && !isEnrolOnlyPath(path)) redirect(ENROL_PATH);
  const { t: tt } = await getDictionary();
  if (path) {
    const to = appRedirect({
      path,
      search: headerStore.get(SEARCH_HEADER) ?? "",
      honestSlug: honest,
      selection,
      channels,
      operator,
    });
    if (to) redirect(to);
  }
  const email = user?.email ?? null;
  // The photo's cache-buster, from the user the layout already read (no extra request). Untrusted: lib/avatar.ts.
  const avatarV = avatarVersionFromMetadata(user?.user_metadata);
  // The customer sidebar's width is a per-browser preference (a cookie mirrored from localStorage), read here so the
  // first frame is already the right width.
  const sidebarCollapsed = isSidebarCollapsed((await cookies()).get(SIDEBAR_COOKIE)?.value);
  // Owner mode (lib/owner-mode.ts): which frame the operator is DRAWN in. The cookie counts only once the server said
  // "operator"; the redirects above already used the real role, so every operator URL keeps working in either frame.
  // The account switcher (User / Owner) is the platform OWNER's: an admin who is not the owner has no Owner account, and a
  // customer is never asked (no lookup). Decided by the database's own answer (lib/server/owner-view), never by the cookie.
  const ownerAccount = operator ? await isPlatformOwner() : false;
  const frame = ownerFrame(operator, (await cookies()).get(OWNER_MODE_COOKIE)?.value, ownerAccount);

  // Credits in the header, for an organization that pays. The operator's own
  // (default) organization is exempt and shows none; so does a database
  // without migration 0020 — never a made-up zero.
  // The plan beside them (0034's billing_summary) names the plan on the
  // sidebar's user card and in the credit menu; unreadable is unknown, and an
  // unknown plan is left unnamed rather than called Free. Both reads are the
  // member's own session (RLS), read-only.
  let credits: CreditAccount | null = null;
  // When the balance was read, so the header's live store (lib/credits-live) never trades a fresher reading of its own for this one.
  let creditsReadAt: string | null = null;
  let plan: AccountPlan | null = null;
  // Film Studio under `on` is listed by the open workspace's own switch (org_film_settings, 0198), in the every-channel roll-up too:
  // the pages and routes behind the entry check that workspace. Started here beside the reads below; it never rejects (an unknown
  // switch is "off").
  const filmMode = filmStudioMode();
  const filmOrgOnRead = filmStudioViewerOn(filmMode);
  // Which Studio tools have a model on sale (lib/server/tool-availability.ts): the sidebar, the desk bar, Home and Presets mark the
  // rest "Not available yet" instead of linking to a form that has nothing to pick. Started here so it runs beside the credit reads
  // below (it never rejects: a failure is "unknown"); one read, shared with the page (React cache).
  const toolsRead = readToolAvailability(org.supported && org.current ? org.current.id : null);
  if (org.supported && org.current && !org.current.is_default) {
    const supabase = await createClient();
    if (supabase) {
      const orgId = org.current.id;
      const [res, summary] = await Promise.all([
        readCreditAccount(supabase, orgId).catch(() => null),
        readBillingSummary(supabase, orgId).catch(() => ({ state: "failed" as const })),
      ]);
      credits = res?.account ?? null;
      creditsReadAt = new Date().toISOString();
      plan = accountPlan(planValue(summary), false);
    }
  } else if (org.supported && org.current?.is_default) {
    plan = { kind: "exempt" };
  }
  const tools = await toolsRead;
  const filmOrgOn = await filmOrgOnRead;
  // The DB-IP credit (docs/GEO_BLOCK.md), once for the whole signed-in app: since the availability marks above, every page's shell is
  // shaped by the country filter (readStudioModels -> hideBlockedModelsHere), not only the few pages that drew it. It renders nothing
  // while no model has a country list.
  const geo = (
    // app-geo-credit: on a full-height screen (the Studio canvas) it is a small right-aligned line under the page, not a stray one
    // at its foot (components/studio-canvas/studio-canvas.css).
    <div className="app-geo-credit mt-10">
      <GeoAttribution label={tt.create.geoAttribution} />
    </div>
  );

  // The breadcrumb names a channel the way the switcher does, by its name — the
  // URL carries a slug, which is not always the name the operator gave it.
  const channelNames = Object.fromEntries(
    channels.map((c) => [channelSlug(c, channels), c.name || c.channel_id]),
  );

  const header = (
    <Header
      channels={channels}
      selection={selection}
      // The orgs the caller may be IN, not every org they may read: a platform admin can read every customer's
      // workspace, and those belong in the Customers section, not in this switcher (lib/orgs.ts switchableOrgs).
      orgs={org.switchable}
      currentOrgId={org.current?.id ?? null}
      credits={credits}
      creditsReadAt={creditsReadAt}
      scope={scope}
      email={email}
      avatarV={avatarV}
      operator={frame}
      plan={plan}
    />
  );

  return (
    <AppProviders locale={await getLocale()}>
      <FlashNotice />
      <SessionEndedBar />
      {/* The motion kit's engine for the signed-in app (docs/design/MOTION.md):
          here rather than in the root layout, so the public pages do not carry
          Motion's core until a page of theirs animates with it. */}
      <MotionProvider>
      <NavigationProvider channelNames={channelNames}>
        {/* The optional sections' switches are read HERE, on the server, per request: the navigation lists Ads only while its switch is on. */}
        {/* Drawn as the account in view: the owner's User account lists only what a customer's would (Film Studio's admins-only
            beta included); every page and route still checks the real role. */}
        <ShellProvider operator={frame} ownerSwitch={ownerAccount} features={{ adsFactory: adsFactoryEnabled(), characterStudio: characterStudioEnabled() && likenessFeaturesAllowed(), filmStudio: filmStudioListed(filmMode, frame, filmOrgOn), aiChat: aiChatOpenFor(org.supported ? org.current?.id : null, aiChatEnv()) }} tools={tools}>
        <SidebarProvider initialCollapsed={!frame && sidebarCollapsed}>
          <div className="app-shell atmos relative flex min-h-svh flex-col">
            {/* First stop in the tab order: past the sidebar, the top bar and the tab bar to the page. */}
            <SkipLink />
            <ShellOffsets />
            {/* One delegated listener for every glass key's pointer highlight (app-glass.css). */}
            <GlassPointer />
            <NeuralBackdrop dim />
            {frame ? (
              <div className="relative z-10 flex min-h-svh flex-col">
                <AdminMfaBanner action={operator ? mfa : "allow"} t={tt.mfa} path={path} />
                {header}
                <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                  <SideNav operator />
                  {/* The operator's phone has its bottom tab bar too (SideNav): the page keeps its end above it. */}
                  <main id="main" tabIndex={-1} className="pad-page pad-page-tabbar min-w-0 flex-1 focus:outline-none">{children}{geo}</main>
                </div>
              </div>
            ) : (
              // A customer's frame, as creative apps draw it: the sidebar full
              // height on the left, the top bar and the page to its right. On a
              // phone the sidebar gives way to the bottom tab bar, and the page
              // keeps its end above it.
              <div className="relative z-10 flex min-h-svh">
                <SideNav email={email} avatarV={avatarV} plan={plan} />
                <div className="flex min-w-0 flex-1 flex-col">
                  {/* The operator in the customer's frame (Owner mode off) still gets the second-factor banner. */}
                  {operator && <AdminMfaBanner action={mfa} t={tt.mfa} path={path} />}
                  {header}
                  <main id="main" tabIndex={-1} className="pad-page pad-page-tabbar min-w-0 flex-1 focus:outline-none">{children}{geo}</main>
                </div>
              </div>
            )}
            <CommandPalette scope={scope} operator={frame} />
            <ScrollToTop dock />
            <InstallHint />
            <PendingSweep />
          </div>
        </SidebarProvider>
        </ShellProvider>
      </NavigationProvider>
      </MotionProvider>
    </AppProviders>
  );
}
