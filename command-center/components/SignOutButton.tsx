"use client";

import { useI18n } from "@/lib/i18n/context";
import { useSignOut } from "@/components/account/AccountParts";

export function SignOutButton() {
  const { t } = useI18n();
  const signOut = useSignOut();
  return (
    <button
      onClick={signOut}
      className="btn-sky is-quiet pill h-9 px-3 text-xs font-light sm:px-4 sm:text-[13px]"
    >
      {t.common.signOut}
    </button>
  );
}
