"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import {
  AI_LOWERING,
  aiChoices,
  isAiLockRefusal,
  normalizeAiMode,
  normalizeAiVoice,
  type AiSettingKey,
} from "@/lib/aiDisclosure";
import type { ChannelAgentConfig } from "@/lib/types";

type Notice = { kind: "saved" } | { kind: "lock" } | { kind: "failed"; detail: string } | null;

/**
 * The two channel settings that decide the AI-content label (modules/ai_disclosure.py): `ai_disclosure` and
 * `ai_disclosure_voice`, merged into the live agent_config like the other switches on this card.
 *
 * `never` and `own_clone` lower what is declared to YouTube, Instagram and TikTok, so since migration 0114 only a
 * platform administrator may set them: the database refuses everyone else, an organization's admin included. For
 * anyone else those two options are shown but locked (so the page says why), and if a write is refused anyway
 * (a stale page, a role removed since it loaded) the refusal is worded in the person's language instead of the
 * database's text. A platform administrator sees every option of both. Anyone who may edit the channel can still
 * move a setting to a value that raises the label, including away from a locked one.
 */
export function AiDisclosureSettings({
  channelId,
  agent,
  canEdit,
  canLower,
}: {
  channelId: string;
  agent: ChannelAgentConfig | null | undefined;
  /** May the caller write the channel at all (an editor of its organization)? */
  canEdit: boolean;
  /** Is the caller a platform administrator (may set `never` and `own_clone`)? */
  canLower: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const uid = useId();
  const [mode, setMode] = useState(() => normalizeAiMode(agent?.ai_disclosure));
  const [voice, setVoice] = useState(() => normalizeAiVoice(agent?.ai_disclosure_voice));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const a = t.aiLabel;

  const holdsLocked = !canLower && (mode === AI_LOWERING.ai_disclosure || voice === AI_LOWERING.ai_disclosure_voice);

  async function save(key: AiSettingKey, value: string) {
    if (busy) return;
    const lockedChoice = !canLower && value === AI_LOWERING[key];
    if (lockedChoice) return;
    const supabase = createClient();
    if (!supabase) return;
    const before = key === "ai_disclosure" ? mode : voice;
    setBusy(true);
    setNotice(null);
    if (key === "ai_disclosure") setMode(normalizeAiMode(value));
    else setVoice(normalizeAiVoice(value));
    const revert = () => (key === "ai_disclosure" ? setMode(before as typeof mode) : setVoice(before as typeof voice));
    const { data: current, error: readErr } = await supabase
      .from("channels")
      .select("agent_config")
      .eq("channel_id", channelId)
      .maybeSingle();
    if (readErr) {
      revert();
      setBusy(false);
      setNotice({ kind: "failed", detail: readErr.message });
      return;
    }
    // Merged into the live config so no other setting is overwritten; the other key keeps exactly the text it has.
    const merged = { ...((current?.agent_config as Record<string, unknown> | null) ?? {}), [key]: value };
    const { error } = await supabase
      .from("channels")
      .update({ agent_config: merged, updated_at: new Date().toISOString() })
      .eq("channel_id", channelId);
    setBusy(false);
    if (error) {
      revert();
      setNotice(isAiLockRefusal(error) ? { kind: "lock" } : { kind: "failed", detail: error.message });
      return;
    }
    setNotice({ kind: "saved" });
    startTransition(() => router.refresh());
  }

  const modeId = `${uid}-mode`;
  const voiceId = `${uid}-voice`;
  const disabled = busy || pending || !canEdit;
  const noAccess = canEdit ? undefined : a.noAccess;

  return (
    <div className="g2-sub-block" aria-labelledby={`${uid}-title`}>
      <div className="g2-sub-head">
        <h3 id={`${uid}-title`} className="g2-label">
          {a.title}
        </h3>
      </div>
      <p className="g2-note">{a.intro}</p>

      <div className="flex flex-col gap-1.5 pt-2">
        <label htmlFor={modeId} className="g2-strong">
          {a.modeLabel}
        </label>
        <select
          id={modeId}
          value={mode}
          disabled={disabled}
          title={noAccess}
          onChange={(e) => void save("ai_disclosure", e.target.value)}
          className="ns-field w-full"
          aria-describedby={`${modeId}-hint`}
        >
          {aiChoices("ai_disclosure", canLower).map((c) => (
            <option key={c.value} value={c.value} disabled={c.locked}>
              {c.locked ? `${a.modeOptions[c.value]} (${a.locked})` : a.modeOptions[c.value]}
            </option>
          ))}
        </select>
        <span id={`${modeId}-hint`} className="g2-note">
          {a.modeHint}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 pt-3">
        <label htmlFor={voiceId} className="g2-strong">
          {a.voiceLabel}
        </label>
        <select
          id={voiceId}
          value={voice}
          disabled={disabled}
          title={noAccess}
          onChange={(e) => void save("ai_disclosure_voice", e.target.value)}
          className="ns-field w-full"
          aria-describedby={`${voiceId}-hint`}
        >
          {aiChoices("ai_disclosure_voice", canLower).map((c) => (
            <option key={c.value} value={c.value} disabled={c.locked}>
              {c.locked ? `${a.voiceOptions[c.value]} (${a.locked})` : a.voiceOptions[c.value]}
            </option>
          ))}
        </select>
        <span id={`${voiceId}-hint`} className="g2-note">
          {a.voiceHint}
        </span>
      </div>

      {!canLower && <p className="g2-note pt-2">{a.lockedNote}</p>}
      {holdsLocked && <p className="g2-note">{a.currentLocked}</p>}
      <div className="pt-2" role="status" aria-live="polite">
        {busy && <span className="g2-note">{a.saving}</span>}
        {!busy && notice?.kind === "saved" && <span className="g2-ok">{a.saved}</span>}
      </div>
      {notice?.kind === "lock" && (
        <p className="g2-fail" role="alert">
          {a.lockRefused}
        </p>
      )}
      {notice?.kind === "failed" && (
        <p className="g2-fail tnum" role="alert">
          {a.saveFailed} {notice.detail}
        </p>
      )}
    </div>
  );
}
