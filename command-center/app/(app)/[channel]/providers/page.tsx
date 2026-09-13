import { ProvidersBoard } from "@/components/providers/ProvidersBoard";
import { providersByCategory } from "@/lib/providers";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Providers — per-account API keys, entered on the site and forwarded to the
 * bot repository as GitHub Actions secrets.
 *
 * The configured/not status is read server-side by name only (GitHub never
 * returns a value); a lookup failure degrades to "nothing configured" rather
 * than breaking the page, and the board still lets the operator (re)enter keys.
 */
export default async function ProvidersPage() {
  const groups = providersByCategory();

  let configured: string[] = [];
  if (isGithubConfigured) {
    try {
      configured = await listConfiguredSecretNames();
    } catch {
      configured = [];
    }
  }

  return (
    <ProvidersBoard groups={groups} configured={configured} githubConfigured={isGithubConfigured} />
  );
}
