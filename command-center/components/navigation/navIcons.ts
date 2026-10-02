import {
  TerminalSquare,
  LayoutDashboard, Film, Workflow, Palette, BarChart3, ListVideo, CircleDot, SwatchBook,
  Users, UserCircle, KeyRound, Bot, ListChecks,
  Lightbulb, Brain, GitBranch, GraduationCap, Database, Hash, Ruler, RefreshCw, Gauge,
  History, Plug, TriangleAlert, ScrollText, ShieldCheck, Building2, Lock, Rocket, PieChart, UserCheck, BellRing, ClipboardList, Wallet, Coins, Images, Settings, Cpu, Scissors, Brush, Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { NavKey } from "@/lib/navigation";

/**
 * One icon per section, shared by every navigation surface (the operator's
 * rail, the customer sidebar, the phone's bottom bar), so a section looks the
 * same wherever it is listed.
 */
export const ICONS: Record<NavKey, LucideIcon> = {
  // The record key, not a sparkle: making something is a REC press (IDENTITY.md §Iconography).
  hub: CircleDot,
  settings: Settings,
  design: SwatchBook,
  command: LayoutDashboard,
  create: CircleDot,
  videos: Film,
  studio: Palette,
  styles: Brush,
  library: Images,
  editor: Scissors,
  workflows: Waypoints,
  pipeline: Workflow,
  analytics: BarChart3,
  channels: Users,
  accounts: UserCircle,
  portfolio: PieChart,
  providers: KeyRound,
  models: Cpu,
  billing: Wallet,
  credits: Coins,
  series: ListVideo,
  agents: Bot,
  jobs: ListChecks,
  advisory: Lightbulb,
  intelligence: Brain,
  decisions: GitBranch,
  learning: GraduationCap,
  memory: Database,
  topics: Hash,
  measure: Ruler,
  feedback: RefreshCw,
  autonomy: Gauge,
  onboarding: Rocket,
  organization: Building2,
  developers: TerminalSquare,
  members: ShieldCheck,
  security: Lock,
  approvals: UserCheck,
  alerts: BellRing,
  audit: ClipboardList,
  timeMachine: History,
  integrations: Plug,
  errors: TriangleAlert,
  logs: ScrollText,
};
