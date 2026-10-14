"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { clearAllCreateAttempts } from "@/lib/create-attempt-store";
import { clearAllEditorDrafts } from "@/lib/editor-draft-store";

export function SignOutButton() {
  const router = useRouter();
  const { t } = useI18n();
  async function signOut() {
    const supabase = createClient();
    try {
      if (supabase) await supabase.auth.signOut();
    } finally {
      clearAllCreateAttempts();
      clearAllEditorDrafts();
    }
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
