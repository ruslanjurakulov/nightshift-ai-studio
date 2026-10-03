import { Check, Play } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { StatusLamp } from "@/components/ui/StatusLamp";

type RowState = "done" | "yours" | "next";

/** Where the example run is: everything before your approval is done. */
function rowState(id: string): RowState {
  if (id === "approval") return "yours";
  if (id === "youtube") return "next";
  return "done";
}

/**
 * The hero's picture: one video's rundown, drawn with the app's own parts —
 * the status lamp, the counter face, the lit key. It is the page's one bold
 * move: the whole homepage is dark ink and hairlines, and the only lamp lit
 * on it is this row, the video waiting for its person.
 *
 * An illustration, labelled as one ("Example run"), and a single image to
 * assistive tech: its description is the figure's label, and nothing in it
 * can be pressed. Its rows carry cue numbers, not times: there is no
 * measured duration to show, so none is implied.
 */
export function Rundown({ t }: { t: Dictionary }) {
  const r = t.site.rundown;
  return (
    <figure role="img" aria-label={r.figure} className="st-monitor">
      <div className="st-monitor-head">
        <div className="st-monitor-title">
          <b>{r.title}</b>
          <span>{r.channel}</span>
        </div>
        <span className="st-tag">{r.tag}</span>
      </div>
      <ol className="st-rows">
        {r.rows.map((row, i) => {
          const state = rowState(row.id);
          return (
            <li key={row.id} className="st-row" data-state={state}>
              {/* The cue number, as a broadcast rundown numbers its items. No
                  clock: a time beside each step would read as a speed nobody measured. */}
              <span className="st-row-time st-num">{String(i + 1).padStart(2, "0")}</span>
              <div className="min-w-0">
                <div className="st-row-name">{row.name}</div>
                <div className="st-row-detail">{row.detail}</div>
              </div>
              <span className="st-row-state">
                {state === "done" && <StatusLamp tone="ok" label={r.done} />}
                {state === "yours" && <StatusLamp tone="run" label={r.yours} live size="md" />}
                {state === "next" && <StatusLamp tone="idle" label={r.next} />}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="st-monitor-foot">
        <span className="flex items-center gap-2 text-sm text-[var(--ns-text-dim)]">
          <Check className="size-4 shrink-0 text-[var(--ns-go)]" aria-hidden />
          {r.price}
        </span>
        <span className="st-monitor-keys">
          <span className="st-fake-key">
            <Play aria-hidden />
            {r.watch}
          </span>
          <span className="st-fake-key" data-lit="true">
            {r.approve}
          </span>
        </span>
      </div>
    </figure>
  );
}
