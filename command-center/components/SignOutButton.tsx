"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { clearAllDrafts } from "@/lib/create-draft";

export function SignOutButton() {
  const router = useRouter();
  const { t } = useI18n();
  async function signOut() {
    // The create form's unfinished draft is this person's; it goes with the session, before anything can fail.
    clearAllDrafts();
    const supabase = createClient();
    if (supabase) await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <button
      onClick={signOut}
      className="btn-sky is-quiet pill h-9 px-3 text-xs font-light sm:px-4 sm:text-[13px]"
    >
      {t.common.signOut}
    </button>
  );
}
