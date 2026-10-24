"use client";

import { useId } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";
import { rejectReasonKey, type VoiceProfileView } from "@/lib/custom-voice";
import {
  approveVoice,
  attachVoice,
  deleteVoice,
  deleteVoiceSample,
  detachVoice,
  type ActionResult,
  type VoiceClient,
} from "@/lib/custom-voice-api";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { problemText, refusalText } from "./messages";

/**
 * One voice, in whatever state the database says it is in. Every button asks the database and shows its answer; none of them
 * assumes. A voice id, reference, hash or path is not in `profile`, so none can be shown.
 */
export function VoiceCard({
  profile,
  channelId,
  attachedHere,
  attachedCount,
  onChanged,
}: {
  profile: VoiceProfileView;
  /** The channel the page is about, or null on the every-channel view (no single target to attach to). */
  channelId: string | null;
  attachedHere: boolean;
  attachedCount: number;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const d = t.customVoice;
  const { confirm, dialog } = useConfirm();
  const uid = useId();

  /** Turns an action's answer into what the confirm sheet needs: true, or the sentence to show. */
  function outcome(r: ActionResult): true | string {
    if (r.ok) return true;
    return "refusal" in r ? refusalText(r.refusal, d) : problemText(r.problem, d);
  }

  function ask(opts: {
    title: string;
    message: string;
    confirmLabel: string;
    success: string;
    tone?: "danger" | "primary";
    run: (client: VoiceClient) => Promise<ActionResult>;
  }) {
    return confirm({
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel,
      tone: opts.tone ?? "danger",
      successMessage: opts.success,
      run: async () => {
        const client = createClient() as unknown as VoiceClient | null;
        if (!client) return d.errGeneric;
        const res = outcome(await opts.run(client));
        if (res === true) onChanged();
        return res;
      },
    });
  }

  const p = profile;
  const statusLabel =
    p.status === "pending_verification"
      ? d.statusPending
      : p.status === "testing"
        ? d.statusTesting
        : p.status === "approved"
          ? d.statusApproved
          : p.status === "rejected"
            ? d.statusRejected
            : p.status === "deleted"
              ? d.statusDeleted
              : d.statusUnknown;

  const sampleLine =
    p.status === "deleted"
      ? null
      : p.sampleState === "stored"
        ? d.sampleStored
        : p.sampleState === "purge_pending"
          ? d.samplePurgePending
          : p.sampleState === "purged"
            ? d.samplePurged
            : null;

  const live = p.status === "pending_verification" || p.status === "testing" || p.status === "approved";

  return (
    <li className="ns-panel" data-tone={p.status === "deleted" ? "sunken" : "flat"} aria-labelledby={`${uid}-name`}>
      <div className="p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {/* The name is the person's own text: rendered as text, never as markup. */}
          <h3 id={`${uid}-name`} className="g2-strong break-words min-w-0">
            {p.name}
          </h3>
          <span className="ns-chip" data-plain="true" data-status={p.status}>
            {statusLabel}
          </span>
        </div>

        <p>
          {p.status === "pending_verification"
            ? p.sampleState === "stored"
              ? d.pendingBody
              : d.pendingAwaitingBody
            : p.status === "testing"
              ? d.testingBody
              : p.status === "approved"
                ? d.approvedBody
                : p.status === "rejected"
                  ? fmt(d.rejectedBody, { reason: d[rejectReasonKey(p.rejectReason)] })
                  : p.status === "deleted"
                    ? d.deletedBody
                    : d.unknownBody}
        </p>

        {sampleLine && <p className="g2-note">{sampleLine}</p>}

        {p.status === "testing" && (
          <div className="flex flex-col gap-1" role="group" aria-labelledby={`${uid}-test`}>
            <h4 id={`${uid}-test`} className="g2-strong">
              {d.testTitle}
            </h4>
            {/* TODO(V3 test step): the Studio speech tool needs a priced job (quote, hold, capture) and the voice id, which this
                screen never holds. Until that is wired there is deliberately no call here, and no button that looks like one. */}
            <p className="g2-note" data-testid="test-stub">
              <strong>{d.testStubLabel}.</strong> {d.testStub}
            </p>
            <div>
              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  void ask({
                    title: d.approveTitle,
                    message: d.approveMessage,
                    confirmLabel: d.approve,
                    success: d.approveDone,
                    tone: "primary",
                    run: (c) => approveVoice(c, p.id),
                  })
                }
              >
                {d.approve}
              </button>
            </div>
          </div>
        )}

        {p.status === "approved" && (
          <div className="flex flex-col gap-2" role="group" aria-labelledby={`${uid}-chan`}>
            <h4 id={`${uid}-chan`} className="g2-strong">
              {d.channelTitle}
            </h4>
            {channelId === null ? (
              <p className="g2-note">{d.attachNeedsChannel}</p>
            ) : (
              <>
                <p className="g2-note">{attachedHere ? d.attachedHere : d.disclosureBody}</p>
                <div>
                  {attachedHere ? (
                    <button
                      type="button"
                      className="btn-quiet"
                      onClick={() =>
                        void ask({
                          title: d.detachTitle,
                          message: d.detachMessage,
                          confirmLabel: d.detach,
                          success: d.detachDone,
                          run: (c) => detachVoice(c, p.id, channelId),
                        })
                      }
                    >
                      {d.detach}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() =>
                        void ask({
                          title: d.attachTitle,
                          message: d.attachMessage,
                          confirmLabel: d.attach,
                          success: d.attachDone,
                          tone: "primary",
                          run: (c) => attachVoice(c, p.id, channelId),
                        })
                      }
                    >
                      {d.attach}
                    </button>
                  )}
                </div>
              </>
            )}
            {attachedCount > 0 && <p className="g2-note">{fmt(d.attachedElsewhere, { count: attachedCount })}</p>}
          </div>
        )}

        {(live || p.status === "rejected") && (
          <div className="flex flex-wrap gap-2">
            {p.sampleState === "stored" && p.status !== "rejected" && (
              <button
                type="button"
                className="btn-quiet"
                onClick={() =>
                  void ask({
                    title: d.deleteSampleTitle,
                    message: d.deleteSampleMessage,
                    confirmLabel: d.deleteSample,
                    success: d.deleteSampleDone,
                    run: (c) => deleteVoiceSample(c, p.id),
                  })
                }
              >
                {d.deleteSample}
              </button>
            )}
            <button
              type="button"
              className="btn-danger-quiet"
              onClick={() =>
                void ask({
                  title: d.deleteVoiceTitle,
                  message: d.deleteVoiceMessage,
                  confirmLabel: d.deleteVoice,
                  success: d.deleteVoiceDone,
                  run: (c) => deleteVoice(c, p.id),
                })
              }
            >
              {d.deleteVoice}
            </button>
          </div>
        )}
      </div>
      {dialog}
    </li>
  );
}
