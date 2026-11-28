"use client";

/**
 * The style guide's specimen of the live canvas (operators only, /{channel}/design): every card state from fixtures, the
 * connectors by data type, the empty state, and a key that replays the arrival. Labelled as fixtures on the page (SYSTEM.md
 * §5: a demo animation is labelled as a demo).
 */
import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { LiveNode } from "./LiveNode";
import { LiveConnector, connectorPath } from "./LiveConnector";
import { LiveEmpty } from "./LiveEmpty";
import { liveFixtures } from "./fixtures";
import { Button } from "@/components/ds/Button";

const noop = () => {};

export function LiveSpecimen() {
  const { t } = useI18n();
  const s = t.liveNodes.specimen;
  const [run, setRun] = useState(0);
  const [now] = useState(() => Date.now());
  return (
    <div className="live-specimen flex flex-col gap-4" data-testid="live-specimen">
      <p className="ds-t-caption m-0">{s.note}</p>
      <div>
        <Button variant="secondary" size="sm" onClick={() => setRun((n) => n + 1)}>
          {s.replay}
        </Button>
      </div>
      <div key={run} className="flex flex-wrap gap-4">
        {liveFixtures(now).map((f, i) => (
          <LiveNode key={f.id} {...f} order={i} revealPrompt announce headingLevel={4} onOpen={noop} onRetry={noop} />
        ))}
      </div>
      <p className="ds-t-label m-0">{s.connectors}</p>
      <svg key={`e${run}`} viewBox="0 0 320 140" width="100%" style={{ maxWidth: 420 }} aria-hidden>
        <LiveConnector d={connectorPath(10, 15, 310, 35)} media="text" state="idle" />
        <LiveConnector d={connectorPath(10, 50, 310, 70)} media="image" state="flowing" />
        <LiveConnector d={connectorPath(10, 85, 310, 105)} media="video" state="flowing" />
        <LiveConnector d={connectorPath(10, 120, 310, 130)} media="audio" state="ghost" />
      </svg>
      <LiveEmpty onPick={() => {}} />
    </div>
  );
}
