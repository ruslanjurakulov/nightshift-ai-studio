import { AppProviders } from "@/components/AppProviders";
import { getLocale } from "@/lib/i18n/server";

/** First-run onboarding is the app, not the public site: it gets the app's providers. */
export default async function WelcomeLayout({ children }: { children: React.ReactNode }) {
  return <AppProviders locale={await getLocale()}>{children}</AppProviders>;
}
