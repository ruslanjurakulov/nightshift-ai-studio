"use client";

import { useDeviceAccountsSync } from "@/lib/device-accounts-client";

/**
 * Mounted once, in the root layout, so EVERY tab hears another tab switch, add or sign out an account and reloads: a page
 * with no account menu (/welcome, a public page signed in) would otherwise keep submitting as the account it no longer is.
 */
export function DeviceAccountsSync() {
  useDeviceAccountsSync();
  return null;
}
