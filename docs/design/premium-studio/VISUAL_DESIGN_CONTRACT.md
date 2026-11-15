# Premium UI visual and interaction contract

Status: Phase B proposal for owner review, not implemented. Source baseline: `f985b3afd371c0677357670da436ef2074fdb036`, inspected in the clean main worktree. No CSS, application, database, deployment or production changes were made. All ten numbered reference images and both original brand reference images were opened and visually inspected. No rendered application screenshot comparison or usability test was performed in this phase.

## 1. Authority and reference interpretation

The uploaded `CODEX_MASTER_PROMPT.md` and `README_FIRST.md` define the requested visual direction. Their explicit product decisions override contradictory details in the pictures. The references supply composition and visual language, not business facts, implemented capabilities or replacement brand assets.

Resolve these contradictions before implementation:

1. Remove the large Personal Studio / Owner Command segmented control shown in reference headers. Mode selection belongs only inside the top-right N account menu. Do not add a second mode switch in page content, the sidebar footer or Studio toolbar.
2. References 08, 09 and 10 incorrectly retain owner financial/provider/customer navigation on Personal Studio and customer screens. Do not copy that sidebar. Ordinary users and owner-in-Personal-Studio use the existing customer navigation and shared creative components. Only Owner Command exposes owner operational destinations.
3. Several images highlight Executive Overview together with a different current page. Exactly one current navigation destination receives selected styling; use existing pathname matching and `aria-current`.
4. Reference 07's SOC 2, backup recovery, trusted-device, OAuth/SSO and password-policy claims are illustrative. Do not draw a green compliance badge from a missing backend contract. Reference 04's Stripe branding does not establish a Stripe integration. Reference 06's GPU/VRAM/cluster cards do not establish installed hardware or observability.
5. Reference 08's “one prompt → multiple cards” switch and reference 10's top-level Generate/Auto-build/Assemble controls are proposed workflows, not evidence that the existing graph executor or durable synchronization is complete. Unimplemented actions remain absent or visibly unavailable with a remedy, never successful-looking.
6. Mock customer emails, avatars, counts, health percentages, balance forecasts and plan names must not become shipped fixtures. Fixture-only review builds must carry an unmistakable test-data label, separated from production adapters.

## 2. Existing system to reuse

Paths below are relative to the repository root at the frozen baseline.

| Existing source | Evidence and design implication |
|---|---|
| `command-center/app/globals.css:1` | Existing `--ns-*` identity tokens and legacy `--color-*`, `--studio-*`, `--shell-*` aliases; reuse the token system rather than creating another design framework. Current dark palette is warm charcoal/amber, unlike the new references. |
| `command-center/app/globals.css:34` | Onest sans and system monospace; preserve current font delivery, 13/14/16/18/20/24/30/40 scale and 400/500/600 weights. |
| `command-center/app/globals.css:98` | Existing 4px spacing, radii, 44px controls and icon sizes; retain these accessible primitives. |
| `command-center/app/globals.css:1349` and `:1695` | Existing focus and reduced-motion rules must survive palette changes. |
| `command-center/lib/theme.ts:1` | `chronos_theme` storage and prepaint theme application already exist; no second theme state/provider or forced dark theme. |
| `command-center/components/ThemeToggle.tsx:12` | Reuse existing synchronized theme handler; replace presentation with compact Sun/Moon controls inside AccountMenu. |
| `command-center/components/account/AccountMenu.tsx:32` | Existing account dialog, read-only account refresh, focus trapping, Escape and focus restoration; extend this component. Settings and sign out already have real handlers at `:278` and `:282`. |
| `command-center/components/account/AccountMenu.tsx:243` | Current theme/language controls are only visible in the phone section; the requested account menu theme controls must work at all widths. |
| `command-center/components/Header.tsx:78` | Studio already portals its project toolbar into the shared header slot. Preserve one toolbar; do not stack a second page header over it. |
| `command-center/components/shell/CustomerSidebar.tsx:45` | Existing collapse state, wordmark, navigation, tooltips and account card; restyle and reuse, do not duplicate. |
| `command-center/lib/navigation.ts:35`, `:42`, `:165` | Owner landing is `/command-center`, customer landing `/home`, film projects `/create/projects`; labels may improve without inventing parallel routes. |
| `command-center/app/(app)/layout.tsx:95`, `:217` | Operator authorization and shared shell already exist. Visual mode is not an authorization grant. |
| `command-center/components/view-mode/ViewModeToggle.tsx:21` | This is the Mobile/Desktop viewport switch using `ns_view`, **not** the Owner/Personal mode selector. Do not repurpose it or remove its feature parity accidentally. |
| `command-center/components/ui/Panel.tsx:14`, `Chip.tsx:14`, `StatusLamp.tsx:16`, `PriceButton.tsx:48`, `SegmentedSwitch.tsx:20` | Reuse existing panel/chip/status/price/segmented interaction primitives. A new look must not remove price pending/refused states or keyboard navigation. |

Older `docs/design/IDENTITY.md` and existing color guidance must be reconciled in the eventual approved design PR. The archive's navy/violet visual precedence is explicit; do not silently leave competing warm-amber guidance described as the new target.

## 3. Exact brand preservation

Immutable source assets: `command-center/brand/logo/nightshift-mark.svg`, `nightshift-mark-dark.svg`, `nightshift-wordmark.svg`, `nightshift-app-icon.svg`; retain `components/site/brandMarkArt.ts` and `wordmarkArt.ts` unchanged. Do not trace the uploaded references, type NIGHTSHIFT in a substitute font, redraw a letter N, flatten the fold, recolor its geometry, distort its proportions or regenerate favicon assets.

`command-center/components/site/Wordmark.tsx:7`–`:21` already defines the bare folded N and lettering with their measured relationship; `:33` exposes the `mark` variant. Its `MarkDefs`/`MarkBody` and theme fold behavior remain authoritative. The sidebar uses this component already (`CustomerSidebar.tsx:91`). Existing brand tests remain mandatory.

For the requested top-right **N avatar trigger**, compose the existing bare-N mark inside the account trigger's circle. Change only the trigger presentation in AccountMenu, not every user avatar. `components/account/Avatar.tsx:7`–`:27` implements private profile pictures and email initials; preserve it in the account panel, settings, profile and any existing user identity surfaces. The account trigger must be named “Account menu” in the active locale, not expose an email through decorative image alt text. A circular frame or subtle violet background is decoration around the unchanged N artwork.

## 4. Proposed tokens

The following hexadecimal values are **design choices proposed here**, not claimed pixel samples from the references. They interpret the observed navy ground, differentiated translucent-looking panels, violet primary accents, and restrained semantic colors. No token has been applied.

| Role / existing token family | Proposed dark | Proposed light | Usage |
|---|---|---|---|
| Ground `--ns-ground` | `#0C1020` | `#F4F5FB` | App canvas surrounding panels; avoid pure black everywhere. |
| Console `--ns-console` | `#141A2E` | `#FFFFFF` | Cards, menus, drawer surfaces. |
| Key `--ns-key` | `#1E2741` | `#ECEFF8` | Inputs, inset metrics, table headers. |
| Key hover `--ns-key-hi` | `#293552` | `#E3E8F5` | Hover/pressed secondary controls. |
| Text `--ns-text` | `#F3F4FF` | `#17203B` | Headings, values, reading text. |
| Secondary `--ns-text-dim` | `#B9C2DC` | `#52617F` | Supporting text; no opacity reduction over charts. |
| Quiet rule `--ns-rule` | `#384567` | `#CBD3E6` | Decorative panel separation only. |
| Interactive rule `--ns-rule-strong` | `#7484A8` | `#7383A3` | Field/control outlines where boundary is needed. |
| Primary CTA `--ns-cta-bg` | `#6D28D9` | `#6D28D9` | One primary commitment per section. |
| Primary CTA foreground | `#FFFFFF` | `#FFFFFF` | Labels and credit price on CTA. |
| Accent/focus `--ns-act` / `--ns-focus` | `#9B8AFB` | `#6D28D9` | Selection/focus; do not rely on glow alone. |
| Success foreground/background | `#6EE7B7` / `#12372C` | use existing tested light success pair | Completed and verified good status only. |
| Warning foreground/background | `#FBBF24` / `#3B2E15` | use existing tested light warning pair | Low balance, stale data, incomplete coverage. |
| Failure foreground/background | `#FDA4AF` / `#401C2C` | use existing tested light failure pair | Failed/refused/destructive states, not every expense. |

Use a restrained violet CTA gradient from `#7C3AED` to `#6D28D9`; white remains readable at both endpoints. Selected navigation may use a muted violet fill plus a visible border. Keep small meaningful cyan/emerald accents for data series or media type; finance costs are not automatically red failures. Large decorative glows sit behind panel content, not behind text, controls or timecodes. Do not copy repeated neon outlines around every nested card: one elevation/border hierarchy makes the reference style readable.

Contrast calculations performed with the WCAG sRGB relative-luminance formula for these proposed flat pairs:

| Pair | Ratio |
|---|---:|
| Dark main text / console | 15.77:1 |
| Dark secondary text / console | 9.71:1 |
| White / primary CTA | 7.10:1 |
| White / brighter gradient endpoint | 5.70:1 |
| Light main text / white | 16.08:1 |
| Light secondary text / white | 6.22:1 |
| Dark interactive boundary / console | 4.61:1 |
| Light interactive boundary / white | 3.82:1 |
| Dark success / its background | 8.56:1 |
| Dark warning / its background | 7.92:1 |
| Dark failure / its background | 7.82:1 |

These calculations do not certify rendered translucent gradients, hover states or every component. Validate final composited pixels at 4.5:1 for normal text, 3:1 for large text and essential non-text controls. Quiet rules are decorative and must not be the only recognizable input boundary.

For Phase D, scope the first palette rollout to the existing signed-in `.app-shell` and its owned overlays; do not redesign the public landing page as an accidental side effect. Preserve the same root theme resolver. Both `--ns-*` and the existing alias variables must be declared at the active scope because CSS variables resolve where they are declared (documented in globals.css). Portaled dialogs must share that scope. This is a targeted extension of the current tokens, not a new independent stylesheet theme system. If broader palette adoption is later approved, test every consumer before replacing the global blocks.

## 5. Layout, density and type

Preserve Onest and the existing type scale; screenshots' dense labels are not a reason to shrink below 13px. Reading/instructions remain 16px, dense secondary table labels 14px, metadata 13px, screen titles 24–30px. Use tabular numerals for amounts, credits, durations and percentages; retain locale formatting and currency codes. Do not infer USD for unknown currencies or abbreviate a balance so heavily that reserve/available meaning disappears.

Keep the 4px spacing scale: 8px inline clusters, 12px compact control groups, 16px internal sections, 20px phone panel padding, 24px desktop panel padding/gaps, 32px major sections. Card radius16px, control12px, chips/media8px, sheets20px. A compact control may look 32–36px but needs a44px actionable target and clear focus outline. Charts prefer flat plotting grounds with legible grids over heavy glass blur.

At1440 and1920 the owner overview uses four summary cards followed by asymmetric evidence-rich panels; high-information tables receive the full available width. Do not force the same fixed dashboard column widths onto every screen. Studio is a work surface with optional left library and right inspector, not another four-KPI dashboard. A selected card is identified by focus/selection and inspector linkage rather than a glow on every card.

## 6. Ten-screen mapping

Route paths are existing `/{channel}/...` destinations, not proof of live runtime configuration. A new tab can compose existing content, but must not introduce a duplicate page or backend.

| Reference | Proposed landing/composition | Existing sources to reuse | Visible gaps or exclusions |
|---|---|---|---|
| 01 Executive overview | `/{channel}/command-center` | Existing page widgets, `components/dashboard/*`, PageHeader, activity/system status | Revenue/profit/provider forecasts only from owner contracts with coverage; date/refresh/export require real implementations. No payment action from a decorative provider card. |
| 02 API & Model Intelligence | `/{channel}/providers` + existing owner billing/provider panels | `components/providers/ProvidersBoard.tsx`, `PipelineRouting.tsx`; `/{channel}/billing` provider spend panels | Provider carousel/dropdown must select a configured provider, not invent API integration. Provider balances/currencies/forecast coverage remain separate. |
| 03 Customers | `/{channel}/customers` | `components/customers/CustomersReport.tsx`, server operator guard in page at`:55` | Search/sort/pagination reuse server query behavior; churn scoring/recent upgrades only if backed. No mock customer PII or invented Enterprise tier. |
| 04 Subscriptions & Payments | `/{channel}/billing`, customer records/detail where authorized | `components/billing/BillingBoard.tsx`, current payments/subscription server contracts | Do not copy Stripe, card PAN fragments, invoice success or auto-renew status without verified source. Payment mutations remain gated. |
| 05 Finance & Profit | `/{channel}/margin` | `components/margin/MarginReport.tsx`, UnitEconomicsCard/provider spend | Distinguish contribution/gross/net and unknown costs. Full P&L/fees/OPEX/tax completeness may require a future data extension. |
| 06 Infrastructure | existing `/{channel}/jobs`, logs, errors, command-center system health | JobStatusLamp, existing queue status, SystemStatus and existing telemetry | An Infrastructure navigation label may group these existing pages. GPU/VRAM, cron, uptime, incident histories require actual telemetry; no SSH/restart/deploy control added. |
| 07 Security & Audit | `/{channel}/security`, `/{channel}/audit` | `components/security/SecurityBoard.tsx`, OwnerSecurityPanel, audit page | No investor role; organization roles are not new platform roles. SOC2/backup/device-trust/SSO read unknown unless evidenced. |
| 08 Personal Studio Canvas + Timeline | existing `/{channel}/studio` with shared film project surfaces | StudioCanvas, FlowBoard, StudioTimeline imported by studio page`:5`–`:6`; FilmCanvas in project detail | No second graph or timeline model. Distinguish input-dependency wires from film playback order. Durable autosave and sync statuses depend on the core data contract. |
| 09 Customer dashboard | `/{channel}/home` | `components/home/HomeHub.tsx`, existing account/credits/creation data | Customer navigation only. Credits distinguish available/reserved; “active projects” count excludes local sketches if not durable. Upgrade opens existing authorized checkout/plan path, no hardcoded plan values. |
| 10 Customer composer | `/{channel}/studio`, with `/{channel}/create`/projects for supported workflow | StudioCanvas inspector and composer, CreateStudio/GenerateSection, existing library/editor | Avoid two Generate buttons implying different spend flows. Auto-build proposes editable cards, never auto-spends. Assemble/export use existing film/editor contracts, or unavailable state. |

## 7. Exact icon contract

Reuse `lucide-react`, already used across Header, AccountMenu and SideNav. Use consistent20px/1.75stroke in controls,16px inline,24px section emphasis; logo and provider marks are not replaced by generic Lucide artwork. All49 named symbols below were found in the existing workspace's installed Lucide declarations. Recheck the approved branch's exact lockfile/install before implementation; no new icon package is proposed.

| Purpose | Lucide symbol | Interaction / accessible name |
|---|---|---|
| Executive overview | `LayoutDashboard` | Existing owner landing link; current-page state. |
| API/model intelligence | `Cpu` | Existing provider destination; model identity text remains visible. |
| Customers | `Users` | Owner customer report. |
| Subscriptions/payments | `WalletCards` | Existing billing destination, not a payment submission. |
| Finance | `ChartColumn` | Owner margin/report destination. |
| Infrastructure | `Layers` | Existing operational group and real queue/log destinations. |
| Security/audit | `ShieldCheck` | Existing guarded route, not a claim of compliance. |
| Personal Studio | `Clapperboard` | Owner menu link to shared customer experience. |
| Owner Command | `Monitor` | Owner-only menu entry; server-derived eligibility. |
| Settings / sign out | `Settings` / `LogOut` | Existing account link/handler. |
| Light / dark | `Sun` / `Moon` | Compact icon-only group with localized names and `aria-pressed`; same theme handler. |
| Search / filters / period | `Search` / `Filter` / `CalendarDays` | Existing search/query/filter; date selection changes a bounded report query. |
| Refresh / CSV export | `RefreshCw` / `Download` | Actual authorized refresh/export only; explain missing source if unavailable. |
| Provider billing link | `ExternalLink` | Verified official URL, clearly opens another site; no auto-top-up. |
| Notification/help | `Bell` / `BookOpen` | Existing notification/help destinations; unread count from actual source. |
| More / expand | `Ellipsis` / `ChevronDown` | Named menu or disclosure, real options only. |
| Add/remove card | `Plus` / `Minus` | Existing graph edit handler; undoable where supported. |
| Connect/disconnect | `Link2` / `Unlink` | Typed input wiring; existing validation and error text. |
| Undo/redo / pan/select | `Undo2` / `Redo2` / `Hand` / `MousePointer2` | Existing canvas history and tools; keyboard alternatives retained. |
| Image/video/audio/voice | `Image` / `Video` / `Music` / `Mic` | Type label/filter, not a separate unpriced generation handler. |
| Upload / library | `Upload` / `FolderOpen` | Existing tenant-private upload/library flow. |
| Generate / propose cards | `Sparkles` | Existing price/approval gate; distinguish proposal from spending. |
| Preview / pause | `Play` / `Pause` | Local media preview, never publication. |
| Split/duplicate/delete | `Scissors` / `Copy` / `Trash2` | Existing timeline/project edit; destructive confirmation only where needed. |
| Lock/visible/mute | `LockKeyhole` / `Eye` / `VolumeX` | Do not render active controls until the track model supports these states. |
| Warning/info/success | `TriangleAlert` / `Info` / `CheckCircle2` | Paired with status text; never color alone. |

Disabled tooltip-only controls are insufficient: adjacent short text or a discoverable detail explains why unavailable and the next step. Unsupported actions may be omitted where presenting an entire inactive toolbar is misleading.

## 8. Account menu and shell behavior

One top-right N account trigger remains visible on every signed-in route at every width, including Studio. Keep workspace/channel and credits accessible without overlapping it. Owner entries: Personal Studio, Owner Command, Settings, compact theme controls, sign out; retain existing necessary account/credit/language controls in an organized secondary area. Ordinary users receive no Owner Command entry, owner URL suggestion or owner-only menu content in client props.

Reuse the account dialog's focus management, Escape, outside-click and focus restoration. A compact theme group gets a shared accessible label and named Sun/Moon buttons. Do not nest a second modal for mode selection. A mode switch changes presentation/destination; it cannot change identity, organization, membership, spending exemption or RLS. Default personal workspace/channel must be explicit and preserve drafts; switching away from unsaved changes offers save/recovery rather than clearing local state.

The current `ShellContext.operator` is both presentation input and derived from server authorization; implementation must separate authorized owner eligibility from the selected presentation mode without replacing the server guard. Missing eligibility lookup fails closed with an access/read error, not an invented owner success state. Parent security contract supplies the exact server API decisions.

## 9. Responsive and keyboard contract

| Width | Dashboard behavior | Studio behavior |
|---|---|---|
|375/390/430|Single-column cards; no owner sidebar copied into customer mode; existing bottom navigation remains. N account trigger stays visible; account popover becomes bounded sheet. Search/filter/date/export wrap or enter a named overflow menu. Tables provide a labeled local horizontal scroller or purposeful mobile row detail, never page-wide overflow.|One working area at a time. Canvas, library, inspector and timeline use named tabs/sheets; inspector opens for selected node and returns focus. Canvas itself may pan horizontally, but does not drag the page. A list view and keyboard node editing remain possible. Preserve44px controls.|
|768|Two-column summary grid where labels fit; sidebar may remain compact/collapsible using existing behavior; filter bar wraps.|Canvas gets main width; library/inspector are drawers or exclusive side panels. Timeline full width below; no three narrow unreadable panes.|
|1440|Four summaries where meaningful, asymmetric panels, wide tables; roughly240–256px nav, fluid content.|Library240–272px, inspector280–320px, flexible canvas, resizable timeline; actual minimum widths verified with English/Russian/Uzbek.|
|1920|Keep usable plotting/table width; avoid stretching paragraphs across screen; intentional max-width or expanded data columns.|More canvas area rather than inflated controls; persistent side panels may remain. Timeline labels and timecodes maintain same font size.|

Pixel widths above are proposed layout targets, not measured reference dimensions. Respect browser zoom200%, narrow320px reflow check, safe areas and keyboard-open viewport height even though the requested screenshot set starts375px. Do not scale a1920px artboard down as a mobile implementation.

Focus order follows visible controls, not node coordinates. Canvas supports keyboard selection/connect/disconnect, Escape cancellation, Delete with contextual safety, and keyboard zoom/pan alternatives already available or explicitly proposed. Never capture global shortcuts while typing a prompt. Focus rings remain visible above node selection outlines and cannot be clipped by panel overflow. Avoid hover-only destructive controls on touch.

Chart hover details also work on focus/tap; chart headings state metric, currency, period and coverage. Provide an adjacent table or text summary. Donut/gauge patterns are used only with valid denominators; an unknown number is not a0% arc. A provider mix with unpriced units is incomplete, not a complete100% pie.

Motion: preserve120/200ms interactions and reduced-motion support. Glows are static; no constantly moving dashboard sparkline, pulsing balance, count-up or animated gradient required. Realtime refresh does not erase table focus, reset scroll or announce every number repeatedly.

## 10. Availability and control inventory contract

Each control mapping in the customer/owner audit must record: route/component, user purpose, handler/server endpoint, read or mutation, persistence, organization/owner authorization, quote/approval requirement, success/error/empty/loading states and current versus proposed status. A control is accepted only when that row is complete.

| UI family | Required behavior |
|---|---|
|Date/filter/search/pagination|Bounded authorized query; filters retained in URL where existing behavior does so; empty query and read failure are different.|
|Refresh|Re-read supported data; preserve last observation with timestamp and stale indicator on failure. No fake “updated” toast.|
|CSV/export|Real report/file output, tenant/owner permissions, correct period/currency, formula-injection-safe cells and explicit incomplete coverage. Rendering video/export is a different priced action.|
|Provider pay/billing/history|Verified official external billing link or supported read-only history. No payment initiation, key display or invented card details.|
|Chart legends/drill-down|If interactive, actually filter/navigate; otherwise visual legend text, not button styling.|
|Customer row “…”|Only currently authorized inspect/account actions. No new impersonation or unrestricted subscription mutation.|
|New project/save/recovery|Existing project paths and data contract; “Saved” only after durable server acknowledgment, “Saved on this device” for local graph, pending/offline/conflict states distinct.|
|Master prompt/auto-build|Create proposed editable cards/scenes for review; no hidden generation charge, render or publish.|
|Generate/assemble|Current quote/hold/capture/refund and versioned approval. No one-click global Generate that bypasses per-card/film gates.|
|Timeline track and dependency tools|Separate input-dependency edges from sequence edits. Unsupported track mute/lock, arbitrary placement or sync buttons are not active until backed by the existing edit model or approved extension.|

Use existing state primitives for loading, not configured, unavailable, empty, denied, failed and stale. Do not use financial green “Active” to mean model API verified, provider funds available and integration healthy at once. These are separate states with separate evidence.

## 11. Proposed implementation touchpoints

Only after scope approval:

1. Extend the existing token and app-shell styles; retain theme resolution and aliases. Restyle existing Panel/Chip/StatusLamp/PriceButton, do not replace their contracts.
2. Extend AccountMenu and Header for the N trigger, all-width theme controls and owner-only mode selection; remove redundant mode switches introduced by later work. Preserve viewport Mobile/Desktop preference as a separate function.
3. Adjust CustomerSidebar/SideNav/navigation only for the approved grouping and selected-state behavior. Owner Personal Studio consumes the same customer routes/components.
4. Restyle existing owner dashboards/reports against approved data contracts; unsupported telemetry/compliance/financial cards receive honest states, not new seeded data.
5. Restyle StudioCanvas/FlowBoard/StudioTimeline/FilmCanvas and existing library/inspector controls after the durable project contract is settled; no parallel engine.
6. Update en/ru/uz dictionaries, existing design guidance, component tests and screenshots together. Do not change publishing, pricing or provider/model availability as part of a CSS PR.

## 12. Visual and functional acceptance

Phase D must capture375,390,430,768,1440,1920 for dark and light, English/Russian/Uzbek, ordinary user, owner Personal Studio and owner Command where applicable. Use deterministic local authorized fixtures and separately prove server permissions; screenshot fixtures are not production usage evidence. Include loading, empty, unavailable, stale, error and insufficient-credit states, account menu open, selected canvas node, conflict recovery and long localized labels. The initial healthy-state matrix is108 viewport/theme/locale/role combinations for a shared representative route, expanded per relevant screen rather than hiding failures behind one screenshot.

Compare against reference intent after explicitly removing its contradictory mode switches/sidebar/data. Review brand geometry, hierarchy, panel separation, violet/semantic restraint, spacing, clipping, table overflow, keyboard focus, reduced motion and chart readability. Document deviations and their source-grounded reason. Do not call a screenshot approval a financial/security approval.

Retain existing brand/account/sidebar/theme/canvas/timeline/quote tests. Add focused regressions for all-width menu access, owner entry absent for customers, server-denied owner navigation, theme hydration and storage-disabled behavior, one header, local-versus-durable save wording, no unsupported-control success and all localization keys. Run the repository's required type/lint/build/test checks appropriate to each approved implementation PR. No application changes were made, so these implementation checks were not claimed run for this design-only artifact.

Read-only verification completed for this proposal: all ten mockups/two brand references visually opened;49 mapped Lucide names present in existing installed declarations; four brand SVG master files byte-equal to frozen HEAD; proposed flat color contrast arithmetic checked as listed; clean-main worktree had no application changes from this task. These checks do not stand in for the Phase D rendered visual, accessibility or backend tests.
