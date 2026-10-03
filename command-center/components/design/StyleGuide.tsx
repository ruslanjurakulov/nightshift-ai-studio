"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { creditUnit, formatCredits } from "@/lib/credits";
import { Timecode } from "@/components/ui/Timecode";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { Meter } from "@/components/ui/Meter";
import { PriceButton } from "@/components/ui/PriceButton";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { Panel } from "@/components/ui/Panel";
import { SegmentedSwitch } from "@/components/ui/SegmentedSwitch";
import { ContactSheet, Frame } from "@/components/ui/ContactSheet";
import { StepCard, StepList } from "@/components/ui/StepCard";

/** The colour roles shown as swatches, in the order IDENTITY.md §2 lists them. */
export const SWATCHES = [
  ["--ns-ground", "ground"],
  ["--ns-console", "console"],
  ["--ns-key", "key"],
  ["--ns-rule", "rule"],
  ["--ns-rule-strong", "ruleStrong"],
  ["--ns-text", "text"],
  ["--ns-text-dim", "textDim"],
  ["--ns-amber", "amber"],
  ["--ns-amber-ink", "amberInk"],
  ["--ns-cta-bg", "ctaBg"],
  ["--ns-tally", "tally"],
  ["--ns-go", "go"],
  ["--ns-cue", "cue"],
  ["--ns-caution", "caution"],
] as const;

const RADII = ["--ns-r-frame", "--ns-r-chip", "--ns-r-key", "--ns-r-panel", "--ns-r-sheet"] as const;
const SIZES = ["--ns-t-label", "--ns-t-small", "--ns-t-ui", "--ns-t-body", "--ns-t-lead", "--ns-t-h3", "--ns-t-h2", "--ns-t-h1"] as const;

/**
 * The living style guide (IDENTITY.md): the same specimen twice, once in a
 * box themed dark and once themed light (data-theme-scope), so both themes are
 * judged side by side whatever the page's own theme is. Every value shown is
 * read back from the CSS at run time — the guide cannot drift from the tokens.
 *
 * Specimen data only: no fetch, no spend; the buttons do nothing.
 */
export function StyleGuide() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="ns-eyebrow">IDENTITY.md</span>
        <h1 className="t-hero">{t.design.title}</h1>
        <p className="t-lead">{t.design.subtitle}</p>
      </header>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Specimen theme="dark" />
        <Specimen theme="light" />
      </div>
    </div>
  );
}

function Specimen({ theme }: { theme: "dark" | "light" }) {
  const { t } = useI18n();
  return (
    <section
      data-theme-scope={theme}
      aria-label={theme === "dark" ? t.design.dark : t.design.light}
      className="ns-specimen flex min-w-0 flex-col gap-8 rounded-[var(--ns-r-panel)] border border-[var(--ns-rule)] bg-[var(--ns-ground)] p-4 text-[var(--ns-text)] sm:p-6"
      data-testid={`specimen-${theme}`}
    >
      <h2 className="font-display text-[26px] font-bold leading-none">
        {theme === "dark" ? t.design.dark : t.design.light}
      </h2>
      <Palette />
      <TypeScale />
      <Shape />
      <Lamps />
      <Timecodes />
      <Meters />
      <Prices />
      <Chips />
      <Modes />
      <Sheet />
      <Steps />
      <Ruler />
    </section>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="ns-eyebrow border-b border-[var(--ns-rule)] pb-2">{title}</h3>
      {children}
    </div>
  );
}

/** A custom property's value on this element, as the browser resolved it. */
function useTokenValues(names: readonly string[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const key = names.join(",");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const style = getComputedStyle(el);
      setValues(Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()])));
    };
    read();
    // The page's own theme toggle changes nothing inside a scoped box, but a
    // republished stylesheet in dev does; re-read when the root theme flips.
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
    // `names` is a constant list per caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { ref, values };
}

function Palette() {
  const { t } = useI18n();
  const { ref, values } = useTokenValues(SWATCHES.map(([n]) => n));
  return (
    <Block title={t.design.sections.palette}>
      <div ref={ref} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SWATCHES.map(([token, role]) => (
          <div key={token} className="flex items-center gap-2.5 rounded-[var(--ns-r-key)] border border-[var(--ns-rule)] bg-[var(--ns-console)] p-2">
            <span aria-hidden className="size-9 shrink-0 rounded-[var(--ns-r-chip)] border border-[var(--ns-rule)]" style={{ background: `var(${token})` }} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-semibold">{t.design.roles[role]}</span>
              <span className="ns-tc truncate text-xs text-[var(--ns-text-dim)]">{values[token] || token}</span>
            </span>
          </div>
        ))}
      </div>
    </Block>
  );
}

function TypeScale() {
  const { t } = useI18n();
  const { ref, values } = useTokenValues(SIZES);
  return (
    <Block title={t.design.sections.type}>
      <div ref={ref} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="ns-eyebrow">{t.design.typeDisplay}</span>
          <p className="font-display text-[40px] font-bold leading-[0.95]">{t.design.typeSample}</p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="ns-eyebrow">{t.design.typeBody}</span>
          <p className="text-base leading-relaxed">{t.design.typeSample}</p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="ns-eyebrow">{t.design.typeMono}</span>
          <p className="text-[18px]">
            <Timecode value={1250} /> · <Timecode value={3727} format="duration" /> · <Timecode value={5.5} format="frames" />
          </p>
        </div>
        <ul className="flex flex-col gap-1.5 border-t border-[var(--ns-rule)] pt-3">
          {SIZES.map((s) => (
            <li key={s} className="flex items-baseline gap-3">
              <span className="ns-tc w-[118px] shrink-0 text-xs text-[var(--ns-text-dim)]">
                {s.replace("--ns-t-", "")} {values[s]}
              </span>
              <span className="truncate" style={{ fontSize: `var(${s})`, fontWeight: s.endsWith("h1") || s.endsWith("h2") ? 700 : 450 }}>
                {t.design.typeSample}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Block>
  );
}

function Shape() {
  const { t } = useI18n();
  const { ref, values } = useTokenValues(RADII);
  return (
    <Block title={t.design.sections.shape}>
      <div ref={ref} className="flex flex-wrap gap-3">
        {RADII.map((r) => (
          <div key={r} className="flex flex-col items-center gap-1.5">
            <span aria-hidden className="size-14 border border-[var(--ns-rule-strong)] bg-[var(--ns-key)]" style={{ borderRadius: `var(${r})` }} />
            <span className="ns-tc text-xs text-[var(--ns-text-dim)]">
              {r.replace("--ns-r-", "")} {values[r]}
            </span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Panel tone="flat" as="div" eyebrow={t.design.flat}>
          <span className="text-xs text-[var(--ns-text-dim)]">.panel</span>
        </Panel>
        <Panel tone="sunken" as="div" eyebrow={t.design.sunken}>
          <span className="text-xs text-[var(--ns-text-dim)]">tone=&quot;sunken&quot;</span>
        </Panel>
        <Panel tone="lifted" as="div" eyebrow={t.design.lifted}>
          <span className="text-xs text-[var(--ns-text-dim)]">--ns-lift</span>
        </Panel>
      </div>
    </Block>
  );
}

function Lamps() {
  const { t } = useI18n();
  const s = t.gen.status;
  const lamps: { tone: LampTone; label: string; live?: boolean }[] = [
    { tone: "idle", label: s.queued },
    { tone: "run", label: s.active, live: true },
    { tone: "ok", label: s.completed },
    { tone: "fail", label: s.failed },
    { tone: "warn", label: s.expired },
    { tone: "idle", label: s.cancelled },
  ];
  return (
    <Block title={t.design.sections.lamps}>
      <div className="flex flex-wrap gap-x-5 gap-y-3">
        {lamps.map((l) => (
          <StatusLamp key={l.label} tone={l.tone} label={l.label} live={l.live} size="md" />
        ))}
      </div>
    </Block>
  );
}

function Timecodes() {
  const { t, locale } = useI18n();
  return (
    <Block title={t.design.sections.timecode}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="ns-eyebrow">credits</dt>
          <dd className="text-[20px]">
            <Timecode value={1250} locale={locale} />
          </dd>
        </div>
        <div>
          <dt className="ns-eyebrow">duration</dt>
          <dd className="text-[20px]">
            <Timecode value={65} format="duration" />
          </dd>
        </div>
        <div>
          <dt className="ns-eyebrow">frames</dt>
          <dd className="text-[20px]">
            <Timecode value={5.48} format="frames" fps={25} />
          </dd>
        </div>
        <div>
          <dt className="ns-eyebrow">null</dt>
          <dd className="text-[20px]">
            <Timecode value={null} unknown={t.design.unknown} />
          </dd>
        </div>
      </dl>
    </Block>
  );
}

function Meters() {
  const { t, fmt, locale } = useI18n();
  const avail = 90;
  const held = 30;
  const unit = creditUnit(avail, locale, t.shell.creditUnit);
  return (
    <Block title={t.design.sections.meter}>
      <div className="flex flex-wrap items-center gap-4">
        <span className="inline-flex items-center gap-2 rounded-[var(--ns-r-key)] border border-[var(--ns-rule)] bg-[var(--ns-console)] px-3 py-2">
          <Meter value={avail} held={held} segments={8} label={t.shell.creditsMenu} />
          <Timecode value={avail} locale={locale} />
        </span>
        <span className="inline-flex items-center gap-2 rounded-[var(--ns-r-key)] border border-[var(--ns-rule)] bg-[var(--ns-console)] px-3 py-2">
          <Meter value={0} segments={8} label={t.shell.creditsMenu} />
          <Timecode value={0} locale={locale} />
        </span>
      </div>
      <div className="max-w-[320px]">
        <Meter
          value={avail}
          held={held}
          size="lg"
          segments={16}
          label={t.shell.creditsMenu}
          valueText={`${formatCredits(avail, locale)} ${unit} ${t.shell.available}`}
          scale={{ from: "0", to: formatCredits(avail + held, locale) }}
        />
        <p className="mt-1 text-xs text-[var(--ns-text-dim)]">{fmt(t.design.held, { n: formatCredits(held, locale) })}</p>
      </div>
    </Block>
  );
}

function Prices() {
  const { t, locale } = useI18n();
  const unit = (n: number) => creditUnit(n, locale, t.shell.creditUnit);
  return (
    <Block title={t.design.sections.price}>
      <div className="flex flex-col gap-3">
        <PriceButton label={t.gen.generate} credits={12} unit={unit(12)} locale={locale} icon={<span aria-hidden className="ns-rec" />} />
        <PriceButton
          label={t.gen.generate}
          credits={6.5}
          was={8.5}
          wasLabel={t.design.was}
          unit={unit(6.5)}
          locale={locale}
          icon={<span aria-hidden className="ns-rec" />}
        />
        <PriceButton label={t.gen.quoting} credits={null} icon={<span aria-hidden className="ns-rec pulse" />} />
        <PriceButton label={t.gen.generate} credits={12} unit={unit(12)} locale={locale} disabledReason={t.design.reasonSample} />
        <div className="flex flex-wrap gap-2">
          <PriceButton size="md" label={t.gen.describe} credits={2} unit={unit(2)} locale={locale} />
        </div>
      </div>
    </Block>
  );
}

function Chips() {
  const { t } = useI18n();
  const [aspect, setAspect] = useState("16:9");
  return (
    <Block title={t.design.sections.chips}>
      <ChipRow label={t.gen.aspectLabel}>
        {["16:9", "9:16", "1:1", "4:5"].map((a) => (
          <Chip key={a} pressed={aspect === a} onClick={() => setAspect(a)} className="ns-tc">
            {a}
          </Chip>
        ))}
        <Chip count={3}>{t.design.count}</Chip>
      </ChipRow>
    </Block>
  );
}

function Modes() {
  const { t } = useI18n();
  const [mode, setMode] = useState<"t2i" | "t2v" | "tts" | "edit">("t2i");
  return (
    <Block title={t.design.sections.modes}>
      <SegmentedSwitch
        label={t.design.sections.modes}
        size="lg"
        value={mode}
        onChange={setMode}
        options={(["t2i", "t2v", "tts", "edit"] as const).map((m) => ({ value: m, label: t.gen.tabs[m] }))}
      />
    </Block>
  );
}

function Sheet() {
  const { t, locale } = useI18n();
  const frames = [
    { art: "lp-art-night", aspect: "16 / 9", edge: ["16:9", "0:05", `${formatCredits(26, locale)} ${t.design.crShort}`] },
    { art: "lp-art-sea", aspect: "16 / 9", edge: ["16:9", `${formatCredits(4, locale)} ${t.design.crShort}`] },
    { art: "lp-art-portrait", aspect: "1 / 1", edge: ["1:1", `${formatCredits(4, locale)} ${t.design.crShort}`] },
    { art: "lp-art-forest", aspect: "16 / 9", edge: ["16:9", "0:10", `${formatCredits(52, locale)} ${t.design.crShort}`] },
  ];
  return (
    <Block title={t.design.sections.sheet}>
      <ContactSheet label={t.design.sections.sheet} min={150}>
        {frames.map((f, i) => (
          <Frame key={f.art} number={i + 1} edge={f.edge} aspect={f.aspect} selected={i === 1}>
            <span aria-hidden className={`lp-art ${f.art} h-full w-full`} style={{ borderRadius: 0, aspectRatio: "auto" }} />
          </Frame>
        ))}
      </ContactSheet>
    </Block>
  );
}

function Steps() {
  const { t, locale } = useI18n();
  const d = t.design;
  const unit = creditUnit(12, locale, t.shell.creditUnit);
  const common = { priceLabel: d.stepPrice, totalLabel: d.stepTotal, unknownPrice: d.stepLater, unit, locale };
  return (
    <Block title={d.sections.steps}>
      <StepList label={d.sections.steps} layout="row">
        <StepCard index={1} title={d.steps.script} state="done" stateLabel={d.stepStates.done} price={4} total={4} {...common} />
        <StepCard index={2} title={d.steps.characters} state="done" stateLabel={d.stepStates.done} price={8} total={12} {...common} />
        <StepCard index={3} title={d.steps.storyboard} state="current" stateLabel={d.stepStates.current} price={24} total={36} {...common} />
        <StepCard index={4} title={d.steps.render} state="next" stateLabel={d.stepStates.next} price={null} total={null} {...common} />
      </StepList>
    </Block>
  );
}

function Ruler() {
  const { t } = useI18n();
  return (
    <Block title={t.design.sections.ruler}>
      <div className="flex flex-col gap-1">
        <div className="ns-ruler" aria-hidden style={{ "--ruler-major": "20%" } as CSSProperties} />
        <div className="flex justify-between text-xs text-[var(--ns-text-dim)]">
          {[0, 1, 2, 3, 4, 5].map((s) => (
            <Timecode key={s} value={s} format="duration" />
          ))}
        </div>
        <span className="sr-only">{t.design.seconds}</span>
      </div>
    </Block>
  );
}
