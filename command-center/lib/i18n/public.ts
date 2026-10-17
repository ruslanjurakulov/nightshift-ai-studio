import type { Dictionary } from "./index";

/**
 * The slice of a dictionary the public pages' client code reads: the header's
 * menu, theme and language keys, the pricing cards, the sign-in and sign-up
 * forms, and the footers. The root layout hands just this to the browser
 * (PublicI18nProvider), instead of all three of the app's dictionaries; the app
 * itself mounts the full I18nProvider inside its own layouts.
 *
 * Built by picking, never by copying text, so it cannot drift from the
 * dictionaries; a client component reading outside it fails to type-check
 * (usePublicI18n), not at run time.
 */
export type PublicDictionary = {
  brand: Pick<Dictionary["brand"], "name">;
  common: Dictionary["common"];
  landing: { nav: Dictionary["landing"]["nav"] };
  legal: Dictionary["legal"];
  // Minus the operator's setup notes (env names, docs paths): they are app copy,
  // never shown to a visitor, and must not ride along in a public page's payload.
  pricing: Omit<Dictionary["pricing"], "comingSoonOperator">;
  plans: Omit<Dictionary["plans"], "managePortalMissing">;
  credits: { buy: { pack: Dictionary["credits"]["buy"]["pack"] } };
  creditsPage: { eq: Dictionary["creditsPage"]["eq"] };
  site: {
    pricingTeaser: Pick<Dictionary["site"]["pricingTeaser"], "credits">;
    auth: Dictionary["site"]["auth"];
    /** The brief, plan, approve flow the sign-in and sign-up stages draw (components/auth/FlowCard.tsx). */
    stage: Pick<Dictionary["site"]["stage"], "tag" | "figure" | "steps">;
    samples: Pick<Dictionary["site"]["samples"], "credit" | "captions">;
    fx: Pick<Dictionary["site"]["fx"], "pause">;
  };
  signup: Dictionary["signup"];
  /** /forgot-password, the "reset your password?" confirmation and /reset-password. */
  recovery: Dictionary["recovery"];
  auth: Pick<Dictionary["auth"], "email" | "password" | "signIn" | "signingIn">;
  /** /login/verify: the second step of sign-in for an account with an authenticator (components/auth/MfaChallenge.tsx). */
  mfa: Pick<
    Dictionary["mfa"],
    | "title" | "subtitle" | "codeLabel" | "codePh" | "factorLabel" | "factorFallback" | "submit" | "submitting" | "loading"
    | "wrongCode" | "expired" | "rateLimited" | "noFactor" | "failed" | "unavailable" | "retry" | "signOut" | "signingOut"
  >;
  /** The error screen (components/feedback/ErrorScreen), shown by app/error.tsx on any page. */
  ux: Pick<Dictionary["ux"], "errorTitle" | "errorBody" | "errorRetry" | "errorHome" | "errorRef">;
};

function omit<T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> {
  const { [key]: _dropped, ...rest } = o;
  void _dropped;
  return rest;
}

export function publicDictionary(t: Dictionary): PublicDictionary {
  return {
    brand: { name: t.brand.name },
    common: t.common,
    landing: { nav: t.landing.nav },
    legal: t.legal,
    pricing: omit(t.pricing, "comingSoonOperator"),
    plans: omit(t.plans, "managePortalMissing"),
    credits: { buy: { pack: t.credits.buy.pack } },
    creditsPage: { eq: t.creditsPage.eq },
    site: { pricingTeaser: { credits: t.site.pricingTeaser.credits }, auth: t.site.auth, stage: { tag: t.site.stage.tag, figure: t.site.stage.figure, steps: t.site.stage.steps }, samples: { credit: t.site.samples.credit, captions: t.site.samples.captions }, fx: { pause: t.site.fx.pause } },
    signup: t.signup,
    recovery: t.recovery,
    auth: { email: t.auth.email, password: t.auth.password, signIn: t.auth.signIn, signingIn: t.auth.signingIn },
    mfa: {
      title: t.mfa.title,
      subtitle: t.mfa.subtitle,
      codeLabel: t.mfa.codeLabel,
      codePh: t.mfa.codePh,
      factorLabel: t.mfa.factorLabel,
      factorFallback: t.mfa.factorFallback,
      submit: t.mfa.submit,
      submitting: t.mfa.submitting,
      loading: t.mfa.loading,
      wrongCode: t.mfa.wrongCode,
      expired: t.mfa.expired,
      rateLimited: t.mfa.rateLimited,
      noFactor: t.mfa.noFactor,
      failed: t.mfa.failed,
      unavailable: t.mfa.unavailable,
      retry: t.mfa.retry,
      signOut: t.mfa.signOut,
      signingOut: t.mfa.signingOut,
    },
    ux: {
      errorTitle: t.ux.errorTitle,
      errorBody: t.ux.errorBody,
      errorRetry: t.ux.errorRetry,
      errorHome: t.ux.errorHome,
      errorRef: t.ux.errorRef,
    },
  };
}
