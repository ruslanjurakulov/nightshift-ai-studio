import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { ModelKeysBoard } from "@/components/model-keys/ModelKeysBoard";
import { ErrorState } from "@/components/ReadError";
import { StateBlock } from "@/components/states/StateBlock";
import { getDictionary } from "@/lib/i18n/server";
import { guardOperatorPage } from "@/lib/auth/org-roles";
import { requireRole } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";
import { modelKeysOn, readModelKeys } from "@/lib/server/model-keys";
import { buildCards } from "@/lib/model-keys";
import "../../app-pages-g5.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Model API keys — the owner pastes a vendor's API key; the server checks it with the vendor and keeps it in Vault (migration 0123,
 * docs/MODEL_API_KEYS.md).
 *
 * Behind NIGHTSHIFT_MODEL_KEYS (exactly `on`). While it is not, the page is an "off" note and makes NO read: no database call, no GitHub
 * call. The operator guard runs first either way (signed out -> /login, anyone else -> 404, a missing second step -> the code page), and
 * the platform OWNER check right after it: an administrator who is not the owner gets 404, as a stranger does.
 *
 * On, it reads as the signed-in owner (the anon key and their session; no service key): which vendors have a stored key (status and last
 * four characters only; the key itself has no read path at all), and, to say which key a run uses, the NAMES of the GitHub secrets that are
 * set (never their values). An unreadable environment is "unknown", never "none".
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

  const supabase = await createClient();
  const read = supabase ? await readModelKeys(supabase) : ({ state: "failed" } as const);

  let configured: string[] | null = null;
  if (read.state === "ok" && isGithubConfigured && mayReadGithub) {
    try {
      configured = await listConfiguredSecretNames();
    } catch {
      configured = null;
    }
  }

  return (
    <div className="rhythm ns-open g5-page">
      {head}
      {read.state === "unsupported" ? (
        <StateBlock tone="warn" title={m.title}>
          {m.unsupported}
        </StateBlock>
      ) : read.state === "ok" ? (
        <ModelKeysBoard cards={buildCards(read.keys, configured)} />
      ) : (
        <ErrorState message={m.failed} />
      )}
    </div>
  );
}
