import {
  Film, Workflow, BarChart3, Palette, ListVideo, Users, UserCircle, KeyRound,
  Bot, ListChecks, Hash, Ruler, GitBranch, GraduationCap, Database, Gauge,
  RefreshCw, Lightbulb, Brain, History, Plug, TriangleAlert, ScrollText,
  Sparkles, ShieldCheck, Rocket, UserCheck, BellRing, ClipboardList, type LucideIcon,
} from "lucide-react";

/**
 * A consistent page header — an icon tile, the page title, and a lead line —
 * used at the top of every section so the app reads as one product rather than
 * a set of separately-styled screens. The icon per page matches the sidebar's,
 * so a route carries the same mark in the rail and on the page it opens.
 *
 * Server-safe: lucide icons render to plain SVG, so this needs no client
 * boundary. Pass `actions` for a right-aligned control (a button, a pill).
 */
export type PageIcon =
  | "videos" | "pipeline" | "analytics" | "studio" | "series" | "channels"
  | "accounts" | "providers" | "agents" | "jobs" | "topics" | "measurement"
  | "decisions" | "learning" | "memory" | "autonomy" | "feedback"
  | "advisory" | "intelligence" | "timeMachine" | "integrations" | "errors" | "logs"
  | "members" | "onboarding" | "approvals" | "alerts" | "audit";

const ICONS: Record<PageIcon, LucideIcon> = {
  videos: Film,
  pipeline: Workflow,
  analytics: BarChart3,
  studio: Palette,
  series: ListVideo,
  channels: Users,
  accounts: UserCircle,
  providers: KeyRound,
  agents: Bot,
  jobs: ListChecks,
  topics: Hash,
  measurement: Ruler,
  decisions: GitBranch,
  learning: GraduationCap,
  memory: Database,
  autonomy: Gauge,
  feedback: RefreshCw,
  advisory: Lightbulb,
  intelligence: Brain,
  timeMachine: History,
  integrations: Plug,
  errors: TriangleAlert,
  logs: ScrollText,
  members: ShieldCheck,
  onboarding: Rocket,
  approvals: UserCheck,
  alerts: BellRing,
  audit: ClipboardList,
};

export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon: PageIcon;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const Icon = ICONS[icon] ?? Sparkles;
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-4">
        <span
          aria-hidden
          className="mt-1 grid size-11 shrink-0 place-items-center rounded-2xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-[var(--color-primary)]"
        >
          <Icon className="size-[22px]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <h1 className="t-hero">{title}</h1>
          {subtitle && <p className="t-lead mt-3">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
