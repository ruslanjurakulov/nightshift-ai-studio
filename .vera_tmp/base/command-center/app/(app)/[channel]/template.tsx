import { SectionShell } from "@/components/SectionShell";

/**
 * A template re-mounts on every navigation, which a layout does not — that is
 * what lets each screen arrive rather than snap. SectionShell then decides how
 * it arrives: the Command Center as the full-width ground floor, every other
 * section as the direction's centred panel over a dimmed ground.
 */
export default function SectionTemplate({ children }: { children: React.ReactNode }) {
  return <SectionShell>{children}</SectionShell>;
}
