import {
  TerminalSquare, Activity,
  Film, Workflow, BarChart3, Palette, ListVideo, Users, UserCircle, KeyRound,
  Bot, ListChecks, Hash, Ruler, GitBranch, GraduationCap, Database, Gauge,
  RefreshCw, Lightbulb, Brain, History, Plug, TriangleAlert, ScrollText,
  Sparkles, ShieldCheck, Building2, Lock, Rocket, PieChart, UserCheck, BellRing, ClipboardList, Wallet, Coins, Images, Cpu, Scissors, TrendingUp, Brush, Waypoints, Inbox, type LucideIcon,
} from "lucide-react";

/**
 * A consistent page header — a slug line (the page's mark and a hairline, as the
 * public pages open), the title, and a lead line — used at the top of every
 * section so the app reads as one product rather than a set of
 * separately-styled screens. The icon per page matches the sidebar's, so a
 * route carries the same mark in the rail and on the page it opens.
 *
 * Server-safe: lucide icons render to plain SVG, so this needs no client
 * boundary. Pass `actions` for a right-aligned control (a button, a pill).
 */
export type PageIcon =
  | "videos" | "pipeline" | "analytics" | "studio" | "series" | "channels"
  | "accounts" | "portfolio" | "providers" | "agents" | "jobs" | "topics" | "measurement"
  | "decisions" | "learning" | "memory" | "autonomy" | "feedback"
  | "advisory" | "intelligence" | "timeMachine" | "integrations" | "errors" | "logs"
  | "members" | "organization" | "security" | "onboarding" | "approvals" | "alerts" | "audit" | "billing" | "credits" | "usage"
  | "developers" | "library" | "editor" | "models" | "margin" | "styles" | "workflows" | "inbox";

const ICONS: Record<PageIcon, LucideIcon> = {
  videos: Film,
  inbox: Inbox,
  pipeline: Workflow,
  analytics: BarChart3,
  studio: Palette,
  library: Images,
  styles: Brush,
  editor: Scissors,
  workflows: Waypoints,
  series: ListVideo,
  channels: Users,
  accounts: UserCircle,
  portfolio: PieChart,
  providers: KeyRound,
  models: Cpu,
  margin: TrendingUp,
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
  organization: Building2,
  developers: TerminalSquare,
  security: Lock,
  onboarding: Rocket,
  approvals: UserCheck,
  alerts: BellRing,
  audit: ClipboardList,
  billing: Wallet,
  credits: Coins,
  usage: Activity,
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
    <header className="ns-pagehead">
      {/* The slug line the public pages open with: the page's mark, then a hairline. Decorative; the title names the page. */}
      <div aria-hidden className="ns-slug">
        <Icon className="size-[18px]" strokeWidth={1.9} />
        <span className="ns-slug-rule" />
      </div>
      <div className="ns-pagehead-row">
        <div className="min-w-0">
          <h1 className="t-hero">{title}</h1>
          {subtitle && <p className="t-lead mt-3">{subtitle}</p>}
        </div>
        {/* Wraps under the title on a phone: several actions side by side are wider
            than the screen, and `shrink-0` would make the page scroll sideways. */}
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
