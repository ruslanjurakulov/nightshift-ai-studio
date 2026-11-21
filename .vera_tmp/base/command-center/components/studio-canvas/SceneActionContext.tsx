import { useI18n } from "@/lib/i18n/context";
import { useShell } from "@/components/shell/ShellContext";
import { kindLabel, type StudioCapability } from "@/lib/creative/studio";
import { sceneActionDescriptor, type SceneActionSource } from "@/lib/studio/sceneActionDescriptor";

/** Informational copy only: the existing composer retains every action, quote and disabled condition. */
export function SceneActionContext({ capabilities, source }: {
  capabilities: readonly StudioCapability[];
  source: SceneActionSource | null;
}) {
  const { t, fmt } = useI18n();
  const { tools } = useShell();
  const c = t.studioCanvas;
  if (capabilities.length === 0) return null;

  return (
    <section className="cv-block" aria-label={t.gen.toolRowLabel} data-testid="inspector-action-context">
      <h3 className="cv-lbl">{t.gen.toolRowLabel}</h3>
      <ul className="m-0 list-none p-0">
        {capabilities.map((capability) => {
          // Today's node composer has no plan approval read model. Do not infer approval from a finished job.
          const descriptor = sceneActionDescriptor({ capability, status: "draft", source, availability: tools });
          const requirement = descriptor.source.requirement;
          const kinds = requirement === "recording" ? `${c.ports.audio} / ${c.ports.video}` : requirement === "none" ? "" : c.ports[requirement];
          const reason = descriptor.reason === "tool-unavailable"
            ? c.inspector.unavailable
            : descriptor.reason ? fmt(c.node.needsInput, { kinds }) : null;
          return (
            <li key={capability} className="cv-note" data-capability={capability} data-reason={descriptor.reason ?? undefined}>
              <strong>{kindLabel(t, descriptor.capability)}</strong>
              {reason && <p className="cv-note">{reason}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
