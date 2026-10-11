"use client";

import { useId } from "react";
import { HANDLE_MAX, type HandleStatus } from "@/lib/handles";
import { HandleStatusLine } from "@/components/account/HandleStatusLine";
import type { Dictionary } from "@/lib/i18n";

type Strings = Parameters<typeof HandleStatusLine>[0]["strings"];

/**
 * A username field with its live answer underneath: the "@" is drawn in front
 * (typing it too is fine), the status is a polite live region wired to the
 * input as its description. `variant` picks the stylesheet family: the public
 * pages' fields (sign-up) or the app's (Settings).
 */
export function HandleInput({
  variant,
  label,
  value,
  onChange,
  status,
  handle,
  strings,
  disabled,
  required,
  name = "handle",
}: {
  variant: "public" | "app";
  label: string;
  value: string;
  onChange: (value: string) => void;
  status: HandleStatus;
  handle: string;
  strings: Strings & Pick<Dictionary["signup"], never>;
  disabled?: boolean;
  required?: boolean;
  name?: string;
}) {
  const id = useId();
  const statusId = `${id}-status`;
  const pub = variant === "public";
  const input = (
    <span className="relative block">
      <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-[var(--ns-text-dim)]">
        @
      </span>
      <input
        id={id}
        name={name}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={HANDLE_MAX + 1}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        required={required}
        aria-describedby={statusId}
        aria-invalid={status.kind === "taken" ? true : undefined}
        className={pub ? "w-full" : "ns-field w-full"}
        style={{ paddingLeft: 30 }}
      />
    </span>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {pub ? (
        <label className="st-field" htmlFor={id}>
          <span>{label}</span>
          {input}
        </label>
      ) : (
        <div className="g5-field">
          <label className="g5-k" htmlFor={id}>
            {label}
          </label>
          {input}
        </div>
      )}
      <HandleStatusLine id={statusId} status={status} handle={handle} strings={strings} />
    </div>
  );
}
