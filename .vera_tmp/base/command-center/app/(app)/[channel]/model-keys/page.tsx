import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { ModelKeysBoard } from "@/components/model-keys/ModelKeysBoard";
import { StateBlock } from "@/components/states/StateBlock";
import { getDictionary } from "@/lib/i18n/server";
import { guardOperatorPage } from "@/lib/auth/org-roles";
import { requireRole } from "@/lib/auth/roles";
import { isGithubConfigured, listSecretNamesComplete } from "@/lib/server/github-secrets";
import { modelKeysOn } from "@/lib/server/model-keys";
import { ALL_ENV_NAMES, buildCards } from "@/lib/model-keys";
import "../../app-pages-g5.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Model API keys — the owner pastes a vendor's API key; the server checks it with the vendor and FORGETS it (docs/MODEL_API_KEYS.md).
 *
 * Behind NIGHTSHIFT_MODEL_KEYS (exactly `on`). While it is not, the page is an "off" note and makes NO read: no database call, no GitHub
 * call. The operator guard runs first either way (signed out -> /login, anyone else -> 404, a missing second step -> the code page), and
 * the platform OWNER check right after it: an administrator who is not the owner gets 404, as a stranger does.
 *
 * On, the page reads exactly one thing: the NAMES of the GitHub secrets that are set (never their values), to say which key a run uses. An
 * unreadable or possibly truncated listing is "unknown", never "none". It reads no database and shows nothing about any key: no key is ever stored.
 */
export default async function ModelKeysPage() {
  const mayReadGithub = await guardOperatorPage();
  if (!(await requireRole("owner"))) notFound();
  const { t } = await getDictionary();
  const m = t.modelKeys;
  const head = <PageHeader icon="modelKeys" title={m.title} subtitle={m.subtitle} />;

  if (!modelKeysOn()) {
    return (
      <div className="rhythm ns-open g5-page">
        {head}
        <StateBlock tone="idle" title={m.off.title}>
          {m.off.body}
        </StateBlock>
      </div>
    );
  }

  // Ask about EVERY name the vendors' sets mention (the Providers board's allowlist leaves out xAI, AssemblyAI, Runway, Luma and Kling's pair, which
  // would read "not set" for a key that is). A listing GitHub says is longer than what was read is "unknown", never "not set".
  let configured: string[] | null = null;
  let complete = true;
  if (isGithubConfigured && mayReadGithub) {
    try {
      const listing = await listSecretNamesComplete(ALL_ENV_NAMES);
      configured = listing ? listing.names : null;
      complete = listing ? listing.complete : true;
    } catch {
      configured = null;
    }
  }

  return (
    <div className="rhythm ns-open g5-page">
      {head}
      <ModelKeysBoard cards={buildCards(configured, complete)} />
    </div>
  );
}
