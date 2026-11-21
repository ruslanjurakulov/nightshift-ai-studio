"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n/context";
import { takeFlash } from "@/lib/flash";
import { useToast } from "@/components/feedback/ToastProvider";

/** Shows the one-line notice a page left for the app to say (lib/flash.ts), once. Renders nothing. */
export function FlashNotice() {
  const { t } = useI18n();
  const toast = useToast();
  useEffect(() => {
    const code = takeFlash();
    if (code === "password_changed") toast.success(t.accountSecurity.passwordChanged);
    // once per mount of the app shell
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
