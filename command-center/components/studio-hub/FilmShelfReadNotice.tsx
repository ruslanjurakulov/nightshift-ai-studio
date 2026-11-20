"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Note } from "@/components/g3/Section";

/** Re-read this server shelf; never create a project or a generation to recover a read. */
export function FilmShelfReadNotice({ message, retryLabel }: { message: string; retryLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col items-start gap-2">
      <div role="status"><Note>{message}</Note></div>
      <button
        type="button"
        className="btn-quiet min-h-11 px-4 text-sm"
        disabled={pending}
        aria-busy={pending}
        onClick={() => {
          if (pending) return;
          startTransition(() => router.refresh());
        }}
      >
        {retryLabel}
      </button>
    </div>
  );
}
