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
  pricing: Dictionary["pricing"];
  plans: Dictionary["plans"];
  credits: { buy: { pack: Dictionary["credits"]["buy"]["pack"] } };
  creditsPage: { eq: Dictionary["creditsPage"]["eq"] };
  site: {
    pricingTeaser: Pick<Dictionary["site"]["pricingTeaser"], "credits">;
    auth: Dictionary["site"]["auth"];
  };
  signup: Dictionary["signup"];
  auth: Pick<Dictionary["auth"], "email" | "password" | "signIn" | "signingIn">;
  /** The error screen (components/feedback/ErrorScreen), shown by app/error.tsx on any page. */
  ux: Pick<Dictionary["ux"], "errorTitle" | "errorBody" | "errorRetry" | "errorHome" | "errorRef">;
};

export function publicDictionary(t: Dictionary): PublicDictionary {
  return {
    brand: { name: t.brand.name },
    common: t.common,
    landing: { nav: t.landing.nav },
    legal: t.legal,
    pricing: t.pricing,
    plans: t.plans,
    credits: { buy: { pack: t.credits.buy.pack } },
    creditsPage: { eq: t.creditsPage.eq },
    site: { pricingTeaser: { credits: t.site.pricingTeaser.credits }, auth: t.site.auth },
    signup: t.signup,
    auth: { email: t.auth.email, password: t.auth.password, signIn: t.auth.signIn, signingIn: t.auth.signingIn },
    ux: {
      errorTitle: t.ux.errorTitle,
      errorBody: t.ux.errorBody,
      errorRetry: t.ux.errorRetry,
      errorHome: t.ux.errorHome,
      errorRef: t.ux.errorRef,
    },
  };
}
