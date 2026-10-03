"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { StatCard, StatusPill } from "@/components/ui";
import { num, relativeTime } from "@/lib/format";
import type { AccountSummary, AccountsRollup } from "@/lib/channels";

/**
 * Every channel on one screen.
 *
 * Two columns rather than one label, because "what this channel is" and "what
 * it has been doing" are different questions: a live channel can be silent and
 * a paused one can still have a failure on its record, and a single blended
 * badge would answer neither.
 *
 * The rule this screen is built around: a channel that has never run does not
 * have counts of zero, it has no counts. Zeros there would read as a working
 * channel having a slow week — the opposite of what is true — so those cells
 * say so in words instead.
 */
export function AccountsBoard({
  rollup,
  here,
}: {
  rollup: AccountsRollup;
  /** The channel the URL names, marked in the table. Null across all channels. */
  here: string | null;
}) {
  const { t } = useI18n();
  const { accounts } = rollup;
  const window = t.accounts.window.replace("{n}", String(rollup.windowDays));

  // A channel wants attention when it failed, or when a human has to do
  // something about its credential — an expired token stops a channel without
  // any run failing, so neither half catches it alone.
  const attention = accounts.filter(
    (a) => a.activity === "failing" || a.health.actionRequired,
  ).length;

  return (
    <div className="rhythm">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={t.accounts.statAccounts} value={num(accounts.length)} />
        <StatCard label={t.accounts.statLive} value={num(rollup.live)} tone={rollup.live > 0 ? "ok" : "idle"} />
        <StatCard label={t.accounts.statDormant} value={num(rollup.dormant)} tone="idle" />
        <StatCard
          label={t.accounts.statAttention}
          value={num(attention)}
          tone={attention > 0 ? "fail" : "ok"}
        />
        <StatCard label={t.accounts.statUploaded} value={num(rollup.published)} sub={window} />
        <StatCard label={t.accounts.statQueued} value={num(rollup.queued)} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse text-left">
          <thead>
            <tr className="text-xs text-[var(--color-muted)]">
              <th className="px-4 py-2 font-semibold">{t.accounts.thChannel}</th>
              <th className="px-4 py-2 font-semibold">{t.accounts.thStanding}</th>
              <th className="px-4 py-2 font-semibold">{t.accounts.thActivity}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.accounts.thUploaded}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.accounts.thQueued}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.accounts.thFailures}</th>
              <th className="px-4 py-2 font-semibold">{t.accounts.thLastUpload}</th>
              <th className="px-4 py-2 font-semibold">{t.accounts.thLastActivity}</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <Row key={a.channelId} account={a} here={a.channelId === here} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 text-xs leading-relaxed text-[var(--color-muted)]">
        <p>{t.accounts.windowNote.replace("{n}", String(rollup.windowDays))}</p>
        <p>{t.accounts.neverRunNote}</p>
        <p>{t.accounts.dormantNote}</p>
        {rollup.drafts > 0 && <p>{t.accounts.draftNote}</p>}
        <p>{t.accounts.privateNote}</p>
      </div>
    </div>
  );
}

function Row({ account: a, here }: { account: AccountSummary; here: boolean }) {
  const { t } = useI18n();

  const standing = {
    live: { tone: "ok" as const, label: t.accounts.standingLive },
    paused: { tone: "idle" as const, label: t.accounts.standingPaused },
    draft: { tone: "idle" as const, label: t.accounts.standingDraft },
  }[a.standing];

  const activity = {
    "never-run": { tone: "idle" as const, label: t.accounts.activityNeverRun },
    failing: { tone: "fail" as const, label: t.accounts.activityFailing },
    publishing: { tone: "ok" as const, label: t.accounts.activityPublishing },
    // Silence is only worth flagging on a channel that is supposed to be
    // running. On a paused channel or a draft it is the expected state.
    quiet: { tone: a.standing === "live" ? ("warn" as const) : ("idle" as const), label: t.accounts.activityQuiet },
  }[a.activity];

  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-4 py-2.5">
        <Link href={`/${a.slug}/command-center`} className="tap flex items-center text-xs text-[var(--color-fg)] hover:text-[var(--color-primary)]">
          <span className="truncate">{a.name}</span>
        </Link>
        <span className="tnum block truncate text-xs text-[var(--color-muted)]">
          {a.channelId}
          {here && ` · ${t.accounts.youAreHere}`}
        </span>
      </td>
      <td className="px-4 py-2.5">
        <StatusPill tone={standing.tone} label={standing.label} />
      </td>
      <td className="px-4 py-2.5">
        <StatusPill tone={activity.tone} label={activity.label} />
      </td>
      <td className="px-4 py-2.5 text-right tnum text-xs tabular-nums">
        {a.everRan ? num(a.published) : <Absent label={t.accounts.neverRun} />}
      </td>
      {/* Queued stays a real number even for a channel that has never run: a
          queue can be filled before anything ever processes it, and that is
          worth seeing. */}
      <td className="px-4 py-2.5 text-right tnum text-xs tabular-nums">{num(a.queued)}</td>
      <td
        className="px-4 py-2.5 text-right tnum text-xs tabular-nums"
        style={{ color: a.failures > 0 ? "var(--color-fail)" : undefined }}
      >
        {/* No runs means no failures to count — not zero failures out of many. */}
        {a.everRan ? num(a.failures) : t.common.dash}
      </td>
      <td className="px-4 py-2.5 tnum text-xs text-[var(--color-muted)]">
        {a.lastPublishedAt ? relativeTime(a.lastPublishedAt) : <Absent label={t.accounts.never} />}
      </td>
      <td className="px-4 py-2.5 tnum text-xs text-[var(--color-muted)]">
        {a.lastActivityAt ? relativeTime(a.lastActivityAt) : <Absent label={t.accounts.never} />}
      </td>
    </tr>
  );
}

/** A fact that does not exist, said in words. Never a zero. */
function Absent({ label }: { label: string }) {
  return <span className="tnum text-xs text-[var(--color-muted)]">{label}</span>;
}
