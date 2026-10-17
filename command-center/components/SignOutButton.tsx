"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { clearAllCreateAttempts } from "@/lib/create-attempt-store";
import { clearAllEditorDrafts } from "@/lib/editor-draft-store";
import { clearAllDrafts } from "@/lib/create-draft";
import { signOutThisBrowser } from "@/lib/sign-out";
import { useToast } from "@/components/feedback/ToastProvider";

export function SignOutButton() {
  const router = useRouter();
  const { t } = useI18n();
  const toast = useToast();
  async function signOut() {
    // The create form's unfinished draft is this person's; it goes with the session, before anything can fail.
    clearAllDrafts();
    const outcome = await signOutThisBrowser(createClient()?.auth);
    clearAllCreateAttempts();
    clearAllEditorDrafts();
    // Not signed out (even the local clear failed): going to /login would bounce straight back in, so say so and stay.
    if (outcome === "failed") {
      toast.error(t.ownerTruth.signOutFailed);
      return;
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
