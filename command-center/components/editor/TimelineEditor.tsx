"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Pause,
  Play,
  Layers,
  Plus,
  Redo2,
  Scissors,
  Shapes,
  Mic,
  Music,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { Chip } from "@/components/ui/Chip";
import { Timecode } from "@/components/ui/Timecode";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { ImproveWithAi } from "@/components/ai/ImproveWithAi";
import { isImproveKind } from "@/lib/creative/improve";
import type { StudioModel } from "@/lib/creative/studio";
import { VoiceOverRecorder } from "@/components/editor/VoiceOverRecorder";
import { useFullLoadLinks } from "@/components/editor/useFullLoadLinks";
import { loadDocument } from "@/lib/editor-nav";
import {
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  GAIN_UI_MAX,
  GAIN_UI_MIN,
  MAX_AUDIO_CLIPS,
  MAX_DURATION_S,
  MAX_EDITOR_CLIPS,
  MAX_EDITOR_SOUNDS,
  MAX_EDITOR_TEXTS,
  MAX_OVERLAYS,
  MAX_OVERLAY_VIDEOS,
  MAX_TEXT,
  SOUND_FADE_MAX_S,
  DUCK_ATTACK_MAX_S,
  DUCK_ATTACK_MIN_S,
  DUCK_DB_MAX,
  DUCK_DEFAULT,
  DUCK_RELEASE_MAX_S,
  DUCK_RELEASE_MIN_S,
  DUCK_UI_MAX_DB,
  DUCK_UI_MIN_DB,
  XFADE_DEFAULT_S,
  XFADE_MIN_S,
  TEXT_COLOR,
  TEXT_OUTLINE_COLOR,
  TEXT_POSITIONS,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  addClip,
  addSound,
  addStill,
  addText,
  audioInputs,
  canAddSound,
  canSplit,
  clamp,
  clipAt,
  clipEnd,
  clipLength,
  crossfadeOf,
  crossfadeStyleOf,
  exportActive,
  fitSoundToPicture,
  formatTime,
  layout,
  maxCrossfade,
  modelDuration,
  moveClip,
  positionOf,
  removeClip,
  removeSound,
  removeText,
  setClipAudio,
  setCrossfade,
  setCrossfadeStyle,
  soundLength,
  soundWarnings,
  speechSpans,
  closeGap,
  rippleTrimTo,
  rollEdit,
  slideClip,
  slipClip,
  slipRange,
  splitClip,
  textWarnings,
  textsAt,
  toDoc,
  toModel,
  updateSound,
  updateText,
  validateTimeline,
  type EditorAsset,
  type EditorError,
  type EditorExport,
  type EditorModel,
  type SoundClip,
  type TextClip,
  type TextPosition,
  type TimelineDoc,
  type VideoClip,
  type XfadeStyle,
} from "@/lib/editor";
import {
  deleteProject,
  fetchProject,
  requestExport,
  requestExports,
  saveProject,
} from "./editorApi";
import { TimelineStrip, pictureEnd, type Selection, type ToolOp } from "./TimelineStrip";
import { GuidesControls, MarksBar, PreviewGuides, SplitEditTools, ToolPicker, type EditTool } from "./EditCore";
import {
  NO_MARKS,
  extractRange,
  insertAt,
  liftRange,
  markedRange,
  setMark,
  type Marks,
  type RangeProblem,
} from "@/lib/editorRange";
import { GUIDES_OFF, loadGuides, saveGuides, type GuideChoice } from "@/lib/editorGuides";
import { nextShuttle } from "@/lib/editor-shortcuts";
import type { CoreAction } from "./useEditorShortcuts";
import { DraftBanner } from "./DraftBanner";
import { useEditorDraft } from "./useEditorDraft";
import { SoundPreview, previewVolume } from "./SoundPreview";
import { CaptionsPanel, type CaptionModelOption } from "./CaptionsPanel";
import { captionsOf, cuesAt } from "@/lib/captions";
import { CaptionPreview } from "./CaptionPreview";
import { CaptionReviewHints } from "./CaptionReviewHints";
import { isCaptionStyleId, perWordCueIds } from "@/lib/captionStyleTable";
import {
  fitOf,
  previewFrameStyle,
  setClipFit,
  setFrame,
  type Fit,
} from "@/lib/editorFrame";
import { FitPicker, FramePicker } from "./FrameFitControls";
import { ExportPresetPicker } from "./ExportPresetPicker";
import { ExportRatioPicker } from "./ExportRatioPicker";
import { HiresExportQuote, type HiresConfirmation } from "./HiresExportQuote";
import {
  PROJECT_FRAME,
  exportFrameChoice,
  frameMismatch,
  framePresetById,
  frameProblems,
  isExportFrameChoice,
  latestPerFrame,
  otherFrames,
  type ExportFrameChoice,
  type FramePresetId,
} from "@/lib/multiRatioExport/frames";
import {
  aboveFree,
  isHiresPresetId,
  isQuotableFrame,
  overHiresCap,
  overHiresFps,
  type HiresPresetId,
  type QuotableFrame,
} from "@/lib/hiresExport/limits";
import { applyExportPreset, isExportPresetId, setExportFps } from "@/lib/editorExportPresets";
import {
  addOverlay,
  canAddOverlay,
  moveOverlay,
  nudgeOverlay,
  overlayWarnings,
  overlaysAt,
  overlaysOf,
  removeOverlay,
  resetOverlay,
  updateOverlay,
} from "@/lib/editorOverlay";
import { OverlayInspector, OverlayLayer, OverlayPicker } from "./OverlayPanel";
import { ShapeInspector, ShapeLayerView, ShapeMoveSection, ShapePicker } from "./ShapePanel";
import {
  addShape,
  canAddShape,
  moveShape,
  nudgeShape,
  removeShape,
  resetShape,
  setShapeKind,
  shapeAddCheck,
  shapeBudget,
  shapeWarnings,
  shapesAt,
  shapesOf,
  updateShape,
} from "@/lib/editorShapeModel";
import { MAX_SHAPES, type ShapeKind } from "@/lib/editorShapes";
import { ClipGradePanel, GradeFilterDefs } from "./ClipGradePanel";
import { ClipPicture, LookFilterDefs } from "./ClipPicture";
import { ClipFxSections } from "./ClipFxSections";
import { SoundBeatsSection } from "./ClipFxPackSections";
import { beatTimes } from "@/lib/editorBeats";
import { applyCrossfadeToAll } from "@/lib/editorFxPack";
import { countForm } from "@/lib/editorSilence";
import { ClipSpeedSection, OverlayMoveSection, RenderBudgetNotice } from "./ClipMotionSections";
import { OverlayChromaSection, SoundCleanSection } from "./CleanSections";
import { ClipCopyTools, ClipVolumeDetach } from "./ClipSoundTools";
import { OverlayAnimSection, ShapeAnimSection, TextAnimSection } from "./AnimPicker";
import { ANIM_REST, animFrame, playsNatively, writtenText, type AnimFrame } from "@/lib/editorFxPreview";
import { trimLimited } from "@/lib/editorMotion";
import { settleAll, type SettleChange } from "@/lib/editorSettle";
import { SettleNotice } from "./SettleNotice";
import { TransitionStylePicker } from "./TransitionStylePicker";
import { TextLookPicker } from "./TextLookPicker";
import { applyTextLook } from "@/lib/editorTextLook";
import { previewBoxStyle, previewTextStyle } from "@/lib/editorTextLookPreview";
import {
  gradeOf,
  resetClipGrade,
  setClipGrade,
  type ClipGrade,
} from "@/lib/editorGrade";

import { ExportStatusPanel } from "./ExportStatusPanel";
import { useExportPoll } from "./useExportPoll";

import { TimelineViewBar } from "./TimelineViewBar";
import { useTimelineView } from "./useTimelineView";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { usePlayheadScrub } from "./usePlayheadScrub";
import { useStickyOffsets } from "./useStickyOffsets";
import { formatDayTime } from "@/lib/date-format";

/** The first time at which clip `id` is the one the preview shows: its start,
 *  or the end of the clip before it when a cross-fade overlaps the two. */
function firstFrameOf(model: EditorModel, id: string): number {
  const clips = layout(model.clips);
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return 0;
  const starts = [clips[i].start_s, ...(i > 0 ? [clipEnd(clips[i - 1])] : [])];
  return (
    starts.find((t) => clipAt(model, t)?.clip.id === id) ?? clips[i].start_s
  );
}

const HISTORY = 100;
/** A history step restores the complete editable project, including its name. */
type EditorSnapshot = { model: EditorModel; title: string };

const fieldClass =
  "rounded-[var(--ns-r-key)] w-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";
const quietBtn =
  "btn-quiet inline-flex items-center gap-1.5 px-3 py-1.5 text-xs";

/** The preview's playback rate: a browser that cannot play a rate (0.1x and 10x are inside every
 *  major engine's range, but not every engine's) keeps the last one instead of breaking the preview. */
function setRate(v: HTMLVideoElement, speed: number) {
  try {
    v.playbackRate = speed;
  } catch {
    /* NotSupportedError: the export is the reference, the preview only approximates */
  }
}

/** The fastest an element plays (Chromium and Firefox stop at 16x; past it setting the rate throws). A shuttle on a fast
 *  clip is held here, and the transport shows the rate the element really plays at, read back from it. */
const PREVIEW_RATE_MAX = 16;
const shuttleRateFor = (speed: number, shuttle: number) =>
  Math.min(PREVIEW_RATE_MAX, speed * (shuttle > 0 ? shuttle : 1));

/** Keys inside these keep their own meaning. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function textBoxStyle(
  x: TextClip,
  frame: { width: number; height: number },
  anim: AnimFrame = ANIM_REST,
): CSSProperties {
  const width = frame.width;
  const ty =
    x.anchor === "top" || x.anchor === "top-left" || x.anchor === "top-right"
      ? "0"
      : x.anchor.startsWith("bottom")
        ? "-100%"
        : "-50%";
  const moving = anim.dx !== 0 || anim.dy !== 0 || anim.scale !== 1;
  return {
    left: `${x.x * 100}%`,
    top: `${x.y * 100}%`,
    // An entrance / exit moves the text from its anchor (cqw: a share of the frame's width).
    transform: moving
      ? `translate(${anim.dx * 100}cqw, ${(anim.dy * 100 * frame.height) / frame.width}cqw) scale(${anim.scale}) translate(-50%, ${ty})`
      : `translate(-50%, ${ty})`,
    transformOrigin: moving ? "0 0" : undefined,
    opacity: anim.opacity === 1 ? undefined : anim.opacity,
    // Output pixels → a share of the frame's width, so the preview scales like the export.
    fontSize: `${(x.size / width) * 100}cqw`,
    fontWeight: x.bold === false ? 400 : 700,
    color: x.color ?? TEXT_COLOR,
    // Outline, shadow and box of a text look; a text without any keeps the outline it had.
    ...previewTextStyle(
      x,
      width,
      `0 0 2px ${TEXT_OUTLINE_COLOR}, 0 0 2px ${TEXT_OUTLINE_COLOR}, 0 0 3px ${TEXT_OUTLINE_COLOR}`,
    ),
  };
}

/**
 * The editor: a preview, the timeline, and the free tools — trim (handles or
 * numbers), split at the playhead, speed 0.5–2×, the clip's own sound, a
 * cross-fade from the clip before, music and sound effects from the library
 * (where, which part, how loud, fades), and text on the picture (what, when,
 * how big, where). Every change is a new
 * document in memory with undo; Save stores it (the route and the database
 * check it); Export asks the media worker to render the SAVED version. No
 * button here renders, spends or publishes by itself: an export is a request
 * row, free, and ends as a file in the library.
 */
export function TimelineEditor({
  projectId,
  title: initialTitle,
  rev: initialRev,
  doc,
  exports: initialExports,
  assets: initialAssets,
  videos,
  soundFiles = [],
  imageFiles = [],
  orgId = "",
  captionModels = [],
  captionModelsStatus = "ok",
  userId = "",
  aiTools = null,
  aiModels = null,
  offerAssetId = null,
  focusPanel = null,
  multiRatio = false,
  hires = false,
}: {
  projectId: string;
  title: string;
  rev: number;
  doc: TimelineDoc;
  exports: EditorExport[];
  assets: Record<string, EditorAsset>;
  videos: readonly EditorAsset[];
  /** The library's audio files, for music and sound effects. */
  soundFiles?: readonly EditorAsset[];
  /** The library's pictures, for overlays (the videos above serve for those). */
  imageFiles?: readonly EditorAsset[];
  /** The project's organization: auto-captions are priced and run in it (0072). */
  orgId?: string;
  /** The transcription models the member may be sold (empty: auto-captions are not offered). */
  captionModels?: readonly CaptionModelOption[];
  /** Why that list may be empty (not set up here / not enabled / could not be read). */
  captionModelsStatus?: "ok" | "not_enabled" | "error";
  /** The signed-in member: a local draft is kept per member (none without it). */
  userId?: string;
  /** The AI tools sold here (lib/server/ai-tools); null = not known. Drives "Improve with AI" on a clip or picture. */
  aiTools?: readonly string[] | null;
  /** The Studio's models for those tools; null = not known (the Studio picks). */
  aiModels?: readonly StudioModel[] | null;
  /** A finished AI result (a library file id) the Studio sent the person back with: offered as "Add to project". */
  offerAssetId?: string | null;
  /** Open scrolled to a panel ("Improve with AI" → Captions from the library). */
  focusPanel?: "captions" | null;
  /** May one export be asked in several frame sizes here (NIGHTSHIFT_MULTI_RATIO_EXPORT on AND migration 0129 applied,
   *  as the server read them)? Default off: no size picker, and Export is the one plain export it always was. */
  multiRatio?: boolean;
  /** Are the paid 1440p / 4K sizes offered in that picker (NIGHTSHIFT_HIRES_EXPORT on, migration 0132)? Default off. */
  hires?: boolean;
}) {
  const { t, locale } = useI18n();
  const te = t.editor;
  const path = useChannelPath();
  // Leaving this page is a full document load, so no later page keeps its microphone=(self) (lib/editor-nav.ts).
  useFullLoadLinks();
  /** Set once the project is deleted: there is nothing left to warn about losing on the way out. */
  const deleted = useRef(false);
  const ids = useId();

  const [model, setModel] = useState<EditorModel>(() => toModel(doc));
  const [past, setPast] = useState<EditorSnapshot[]>([]);
  const [future, setFuture] = useState<EditorSnapshot[]>([]);
  const [saved, setSaved] = useState(() => JSON.stringify(toDoc(toModel(doc))));
  const [title, setTitle] = useState(initialTitle);
  const [savedTitle, setSavedTitle] = useState(initialTitle);
  const [rev, setRev] = useState(initialRev);
  // Beat markers found for a sound (file seconds, by sound id): the editor's, never the document's.
  const [beatsBySound, setBeatsBySound] = useState<Record<string, number[]>>({});
  const [crossfadeAllNote, setCrossfadeAllNote] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection>(() => {
    const first = toModel(doc).clips[0];
    return first ? { kind: "clip", id: first.id } : null;
  });
  const [playhead, setPlayhead] = useState(0);
  // The editor's own clipboard: one picture clip of this project (copy / paste), never the system's.
  const [clipboard, setClipboard] = useState<VideoClip | null>(null);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<EditorError | "text_empty" | null>(null);
  const [exports, setExports] = useState(initialExports);
  // The sizes the next export makes (only with `multiRatio`): the project's own until the person ticks others.
  const [frames, setFrames] = useState<ExportFrameChoice[]>([PROJECT_FRAME]);
  // Sizes of the last request that were NOT started, each with the refusal's word.
  const [frameRefusals, setFrameRefusals] = useState<{ frame: ExportFrameChoice; error: EditorError }[]>([]);
  const [assets, setAssets] = useState(initialAssets);
  const [adding, setAdding] = useState(false);
  const [addingSound, setAddingSound] = useState(false);
  /** The voice-over panel. Opening it asks for nothing: the microphone is asked for only when Record is pressed. */
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [addingOverlay, setAddingOverlay] = useState(false);
  const [addingShape, setAddingShape] = useState(false);
  // Why the last "Add to video" was refused by the export's budgets (said politely, in words).
  const [shapeRefusal, setShapeRefusal] = useState<"memory" | "time" | null>(null);
  // Where focus goes once the render that follows a shape add / delete is there.
  const shapeFocus = useRef<"frame" | "add" | null>(null);
  const addShapeButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once the render that follows an overlay add / delete is there
  // (the picker unmounts, the inspector goes): never back to <body>.
  const overlayFocus = useRef<"frame" | "add" | null>(null);
  const addOverlayButton = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dragBase = useRef<EditorModel | null>(null);
  // The editing core: the timeline tool, the in / out marks (editor state, never saved), the shuttle's rate
  // (J / K / L; 1 = normal play) and the preview's guides (this browser only).
  const [tool, setTool] = useState<EditTool>("trim");
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const [coreStatus, setCoreStatus] = useState<string | null>(null);
  const [shuttle, setShuttle] = useState(1);
  // The shuttle rate the preview really plays at (the element may hold a fast clip's rate lower, or keep its last one).
  const [shownShuttle, setShownShuttle] = useState(1);
  const shuttleRef = useRef(1);
  shuttleRef.current = shuttle;
  const [guides, setGuides] = useState<GuideChoice>(GUIDES_OFF);
  // Read after the first render: the server has no browser storage, and a differing first render would not hydrate.
  useEffect(() => setGuides(loadGuides()), []);

  const clips = useMemo(() => layout(model.clips), [model.clips]);
  const total = useMemo(() => modelDuration(model), [model]);
  const picture = pictureEnd(clips);
  const current = useMemo(() => JSON.stringify(toDoc(model)), [model]);
  const dirty = current !== saved || title.trim() !== savedTitle;
  const active = exportActive(exports);
  // Whether the edit fits each other size is the whole validator run once per size: kept off the typing / dragging path.
  const settledModel = useDeferredValue(model);
  const frameChoices = useMemo<FramePresetId[]>(
    () => (multiRatio ? otherFrames(settledModel, { hires }) : []),
    [multiRatio, hires, settledModel],
  );
  const frameBlocked = useMemo(
    () => frameChoices.filter((c) => frameProblems(settledModel, c).length > 0),
    [frameChoices, settledModel],
  );
  // What Export would ask for now: a size that is no longer offered (the project took that size) or no longer fits is dropped.
  // A paid size the video is too long for (0132's cap) is not offered either.
  const frameOverCap = frameChoices.filter((c) => {
    const p = isHiresPresetId(c) ? framePresetById(c) : null;
    return p !== null && overHiresCap(p.width, p.height, total);
  });
  // Nor one this project's frame rate is too fast for (4K: 30 at most; never rendered at a lower rate in its place).
  const frameTooFast = frameChoices.filter((c) => {
    const p = isHiresPresetId(c) ? framePresetById(c) : null;
    return p !== null && overHiresFps(p.width, p.height, model.fps);
  });
  // Above 1080p is never free (0132): a project whose own frame is bigger is not exported in its own size by the free
  // request (the server refuses it: hires_needs_paid_export). It is exported in a paid size, or in a free one (1080p or
  // smaller), or after its frame is set to 1080p or smaller. Saving it stays allowed.
  const ownAboveFree = aboveFree(model.width, model.height);
  const ownBlocked = ownAboveFree ? (multiRatio && hires ? te.exportHires.ownTooBig : te.exportHires.ownTooBigOff) : null;
  // A speed curve is sold at its rendered length (migration 0136): the quote prices it, so nothing is held back for it here.
  const framesChosen = frames.filter(
    (c) =>
      (c === PROJECT_FRAME && !ownAboveFree) ||
      (c !== PROJECT_FRAME &&
        frameChoices.includes(c) &&
        !frameBlocked.includes(c) &&
        !frameOverCap.includes(c) &&
        !frameTooFast.includes(c)),
  );
  // Sizes up to 1080p are sold (migration 0136: the owner set their price). Learnt from the server's own refusal of a plain
  // request (export_needs_quote): from then on every ticked size is priced, the project's own included. While that price
  // is NULL the server never says it, and Export is the free request it always was.
  const [soldUpTo1080, setSoldUpTo1080] = useState(false);
  const quoted = multiRatio && hires;
  const paidChosen: QuotableFrame[] = soldUpTo1080
    ? framesChosen.filter((c): c is QuotableFrame => isQuotableFrame(c))
    : framesChosen.filter((c): c is HiresPresetId => isHiresPresetId(c));
  // The person's yes to the server's quote of the paid sizes (HiresExportQuote): Export spends only with it.
  const [paidOk, setPaidOk] = useState<HiresConfirmation>({ ready: false, key: "", maxCredits: {} });
  // A yes counts only for the sizes and the saved version it was given for (a stale one is never sent), and is dropped
  // when no paid size is ticked any more: ticking the same size again asks for a new one.
  const paidReady = paidOk.ready && paidOk.key === `${rev}|${paidChosen.join(",")}`;
  const anyPaid = paidChosen.length > 0;
  // The "applied to all cuts" note belongs to the clip it was given on.
  useEffect(() => setCrossfadeAllNote(null), [selected]);

  useEffect(() => {
    if (!anyPaid) setPaidOk((c) => (c.ready ? { ready: false, key: "", maxCredits: {} } : c));
  }, [anyPaid]);
  const warnings = textWarnings(model);
  const soundWarns = soundWarnings(model);
  const speech = useMemo(() => speechSpans(model), [model]);
  const overlays = overlaysOf(model);
  const overlayWarns = overlayWarnings(model);
  const shapes = shapesOf(model);
  const shapeWarns = shapeWarnings(model);
  const isVideoAsset = (id: string) => assets[id]?.kind === "video";

  // ── local draft: kept on this device, offered back on the next open ────────
  const draft = useEditorDraft({
    userId,
    projectId,
    initialRev,
    rev,
    dirty,
    currentJson: current,
    title,
    saved,
    savedTitle,
    resolveAsset: (id) =>
      assets[id] ??
      [...videos, ...soundFiles, ...imageFiles].find(
        (a) => a.id.toLowerCase() === id.toLowerCase(),
      ),
    onRestore: (d, found) => {
      setAssets((x) => ({ ...found, ...x }));
      // What was on screen (edits made while the offer was open) stays one Undo away.
      gesture.current = null;
      burst.current = null;
      setPast((p) => [...p.slice(-(HISTORY - 1)), { model, title }]);
      setFuture([]);
      setModel(toModel(d.doc));
      setTitle(d.title.slice(0, 120));
      setError(null);
    },
  });

  // ── history ────────────────────────────────────────────────────────────────
  // `group`: the changes of one gesture (a slider drag) are ONE undo step.
  const gesture = useRef<string | null>(null);
  // What the last edit had to settle elsewhere (a backwards part shortened, smoothing
  // switched off ...), said to the person; cleared by the next edit that settles nothing.
  const [settled, setSettled] = useState<SettleChange[]>([]);
  const apply = useCallback(
    (raw: EditorModel, group?: string) => {
      if (raw === model) return;
      // Any edit can push a clip over a limit that depends on something else (the
      // frame shape, the timeline's length, a neighbour's cross-fade): settle it.
      const fixed = settleAll(raw, model);
      const next = fixed.model;
      setSettled(fixed.changes);
      if (!group || gesture.current !== group) {
        setPast((p) => [...p.slice(-(HISTORY - 1)), { model, title }]);
        setFuture([]);
      }
      gesture.current = group ?? null;
      setModel(next);
      setError(null);
    },
    [model, title],
  );
  const undo = useCallback(() => {
    if (!past.length) return;
    gesture.current = null;
    setSettled([]);
    setFuture([{ model, title }, ...future]);
    const previous = past[past.length - 1];
    setModel(previous.model);
    setTitle(previous.title);
    setPast(past.slice(0, -1));
  }, [model, title, past, future]);
  const redo = useCallback(() => {
    if (!future.length) return;
    gesture.current = null;
    setSettled([]);
    setPast([...past, { model, title }]);
    setModel(future[0].model);
    setTitle(future[0].title);
    setFuture(future.slice(1));
  }, [model, title, past, future]);

  useEffect(() => {
    const where = overlayFocus.current;
    if (!where) return;
    overlayFocus.current = null;
    const target =
      where === "add"
        ? addOverlayButton.current
        : (document.querySelector<HTMLElement>("[data-overlay-frame]") ??
          document.querySelector<HTMLElement>("[data-overlay-heading]"));
    target?.focus();
  }, [model, selected]);

  useEffect(() => {
    const where = shapeFocus.current;
    if (!where) return;
    shapeFocus.current = null;
    const target =
      where === "add"
        ? addShapeButton.current
        : (document.querySelector<HTMLElement>("[data-shape-frame]") ??
          document.querySelector<HTMLElement>("[data-shape-heading]"));
    target?.focus();
  }, [model, selected]);

  // A run of small changes to one control (a slider, the arrow keys) is ONE undo step.
  const burst = useRef<{ key: string; at: number; out: EditorModel } | null>(
    null,
  );
  const applyBurst = useCallback(
    (next: EditorModel, key: string) => {
      if (next === model) return;
      const now = Date.now();
      const b = burst.current;
      burst.current = { key, at: now, out: next };
      if (b && b.key === key && b.out === model && now - b.at < 1000) {
        setModel(next);
        setError(null);
        return;
      }
      apply(next);
    },
    [model, apply],
  );

  // A selection whose clip or text is gone (undo, delete) is no selection.
  useEffect(() => {
    if (
      selected?.kind === "clip" &&
      !model.clips.some((c) => c.id === selected.id)
    )
      setSelected(
        model.clips[0] ? { kind: "clip", id: model.clips[0].id } : null,
      );
    if (
      selected?.kind === "text" &&
      !model.texts.some((x) => x.id === selected.id)
    )
      setSelected(null);
    if (
      selected?.kind === "sound" &&
      !model.sounds.some((x) => x.id === selected.id)
    )
      setSelected(null);
    if (
      selected?.kind === "overlay" &&
      !overlaysOf(model).some((x) => x.id === selected.id)
    )
      setSelected(null);
    if (
      selected?.kind === "shape" &&
      !shapesOf(model).some((x) => x.id === selected.id)
    )
      setSelected(null);
  }, [model, selected]);

  useEffect(() => {
    if (playhead > total) setPlayhead(total);
  }, [playhead, total]);

  // ── preview ────────────────────────────────────────────────────────────────
  const video = useRef<HTMLVideoElement>(null);
  const pinned = useRef<HTMLDivElement>(null);
  useStickyOffsets(pinned);
  const at = clipAt(model, Math.min(playhead, Math.max(0, picture - 0.001)));
  const src = at ? (assets[at.clip.asset_id]?.viewUrl ?? null) : null;
  // A picture sent from the Library or Studio is a still: it is drawn, not played.
  const still = at ? assets[at.clip.asset_id]?.kind === "image" : false;
  // The preview follows the playhead: a change to a clip that is not on screen
  // would show nothing, so the playhead goes to the first frame of that clip.
  const showClip = (id: string) => {
    if (at?.clip.id === id) return;
    setPlaying(false);
    setPlayhead(firstFrameOf(model, id));
  };
  const shownClip = useRef<string | null>(null);
  const refreshed = useRef(false);

  useEffect(() => {
    const v = video.current;
    if (!v || !at) return;
    setRate(v, shuttleRateFor(at.clip.speed, shuttle));
    // Fast or backwards shuttle plays no sound (the note under the transport says so).
    v.muted = !at.clip.audio || shuttle !== 1;
    const real =
      shuttle > 0 && playsNatively(at.clip) && at.clip.speed > 0
        ? Math.round(((v.playbackRate || at.clip.speed) / at.clip.speed) * 100) / 100
        : shuttle;
    if (real !== shownShuttle) setShownShuttle(real);
    // The clip's own volume, as far as a browser goes (an element plays at most 100 %; the export does 200 %).
    v.volume = previewVolume(at.clip.gain_db ?? 0);
    const switched = shownClip.current !== at.clip.id;
    shownClip.current = at.clip.id;
    if (!playsNatively(at.clip) || shuttle < 0) {
      // Backwards, frozen or ramped (or the shuttle going backwards): the element cannot play it, so it is stepped to the frame the playhead is at.
      v.muted = true;
      v.pause?.();
      if (Math.abs((v.currentTime || 0) - at.sourceS) > 0.03) {
        try {
          v.currentTime = at.sourceS;
        } catch {
          /* not loaded yet: loadedmetadata seeks */
        }
      }
      return;
    }
    if (!playing || switched) {
      if (Math.abs((v.currentTime || 0) - at.sourceS) > 0.05) {
        try {
          v.currentTime = at.sourceS;
        } catch {
          /* not loaded yet: loadedmetadata seeks */
        }
      }
      if (playing && switched)
        void v.play?.()?.catch?.(() => setPlaying(false));
    }
  }, [at, playing, src, shuttle, shownShuttle]);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  useEffect(() => {
    if (!playing) {
      video.current?.pause?.();
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const ph = playheadRef.current;
      const v = video.current;
      const rate = shuttleRef.current;
      const here = clipAt(model, Math.min(ph, Math.max(0, picture - 0.001)));
      let next: number;
      if (rate < 0) {
        // The shuttle backwards: the clock runs back; the preview steps to each frame (the effect above).
        next = ph + dt * rate;
        if (next <= 0) {
          playheadRef.current = 0;
          setPlayhead(0);
          setPlaying(false);
          return;
        }
      } else if (!here) {
        // Past the picture (text only), or nothing to play: the clock runs.
        next = ph + dt * rate;
      } else {
        const c = here.clip;
        const end = clipEnd(c);
        const viaVideo = Boolean(
          v && src && playsNatively(c) && !v.paused && v.readyState >= 2,
        );
        const t =
          viaVideo && v
            ? c.start_s + (v.currentTime - c.in_s) / c.speed
            : ph + dt * rate;
        // At a clip's end the playhead jumps to the next clip's start.
        next = t >= end - 0.01 ? end : clamp(t, c.start_s, end);
      }
      if (next >= total - 0.001) {
        playheadRef.current = total;
        setPlayhead(total);
        setPlaying(false);
        return;
      }
      playheadRef.current = next;
      setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    const first = clipAt(model, Math.min(playheadRef.current, Math.max(0, picture - 0.001)));
    if ((!first || playsNatively(first.clip)) && shuttleRef.current > 0) void video.current?.play?.()?.catch?.(() => {});
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, model, picture, total, src, shuttle]);
  // Stopping, by any way, ends the shuttle: the next play is at 1x.
  useEffect(() => {
    if (!playing) setShuttle(1);
  }, [playing]);

  const togglePlay = () => {
    if (!playing && playhead >= total - 0.001) setPlayhead(0);
    setShuttle(1);
    setPlaying((p) => !p);
  };

  // Timeline zoom and snapping, the single-key shortcuts, the playhead slider's snapping.
  const view = useTimelineView({ total, playhead });
  useEditorShortcuts({ model, selected, playhead, total, togglePlay, setPlayhead, setPlaying, apply, view, onOverlayRemoved: () => { overlayFocus.current = "add"; }, onShapeRemoved: () => { shapeFocus.current = "add"; }, clipboard, setClipboard, onClipInserted: (id) => setSelected({ kind: "clip", id }), onCore: (a) => onCore(a) });
  const scrub = usePlayheadScrub({ clips, model, view, setPlayhead, setPlaying });

  async function refreshLinks() {
    const out = await fetchProject(projectId);
    if (out.ok) {
      setAssets((a) => ({ ...a, ...out.value.assets }));
      setExports(out.value.exports);
    }
  }

  // ── exports: poll (with backoff) while one is on its way ──────────────────
  const poll = useExportPoll({
    projectId,
    active,
    onSnapshot: (s) => {
      setExports(s.exports);
      setAssets((a) => ({ ...a, ...s.assets }));
    },
  });

  // ── keyboard: undo / redo / save / play ───────────────────────────────────
  const saveRef = useRef<() => Promise<void>>(undefined);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // A text box / number field commits on blur: blur it (and put focus back) so the typed value is in the model, then save the next render's model.
        const f = document.activeElement;
        if ((f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) && f.closest("[data-editor-root]")) {
          f.blur();
          f.focus();
          setTimeout(() => void saveRef.current?.(), 0);
        } else void save();
        return;
      }
      if (typing(e.target)) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (deleted.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ── save / export / delete ────────────────────────────────────────────────
  async function save() {
    if (saving || !dirty) return;
    const docNow = toDoc(model);
    if (Object.values(warnings).includes("empty")) {
      setError("text_empty");
      return;
    }
    if (validateTimeline(docNow).length) {
      setError("invalid_doc");
      return;
    }
    setSaving(true);
    setError(null);
    const out = await saveProject(
      projectId,
      rev,
      title.trim() !== savedTitle ? title : null,
      docNow,
    );
    setSaving(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    // A new persisted revision is a boundary for grouped edits, not a history reset.
    gesture.current = null;
    burst.current = null;
    setRev(out.value.rev);
    draft.afterSave(out.value.rev);
    setSaved(JSON.stringify(docNow));
    setSavedTitle(title.trim());
  }

  /** Export in several sizes (migration 0129): one request, one export per size, each answered by itself. */
  async function startFrameExports(want: readonly ExportFrameChoice[]): Promise<EditorError | null> {
    if (dirty || active || starting) return null;
    if (!want.length) return "bad_request";
    setStarting(true);
    setError(null);
    setFrameRefusals([]);
    const priced = want.filter((c): c is QuotableFrame => isQuotableFrame(c) && paidOk.maxCredits[c] !== undefined);
    // A paid size goes only with the number the person confirmed (the route refuses it without one: quote_required), and a
    // sold size up to 1080p (0136) with its own; a free one goes without, as always.
    const out = await requestExports(
      projectId,
      rev,
      want,
      priced.length && paidReady ? Object.fromEntries(priced.map((c) => [c, paidOk.maxCredits[c] as number])) : undefined,
    );
    setStarting(false);
    if (!out.ok) {
      if (out.error === "export_needs_quote") setSoldUpTo1080(true);
      setError(out.error);
      return out.error;
    }
    const now = new Date().toISOString();
    const queued: EditorExport[] = [];
    const refused: { frame: ExportFrameChoice; error: EditorError }[] = [];
    for (const o of out.value) {
      if ("error" in o) {
        refused.push(o);
        continue;
      }
      const p = o.frame === PROJECT_FRAME ? null : framePresetById(o.frame);
      queued.push({
        id: o.id,
        rev,
        status: "queued",
        reason: null,
        durationS: total,
        assetId: null,
        createdAt: now,
        finishedAt: null,
        ...(p ? { frame: { preset: p.id, width: p.width, height: p.height } } : {}),
      });
    }
    setFrameRefusals(refused);
    if (refused.some((r) => r.error === "export_needs_quote")) setSoldUpTo1080(true);
    // Newest first, like the server's list.
    if (queued.length) setExports((e) => [...queued.reverse(), ...e]);
    return refused[0]?.error ?? null;
  }

  async function startExport(): Promise<EditorError | null> {
    // Only the project's own size (always, without `multiRatio`): the request it always was, byte for byte. Once sizes up
    // to 1080p are sold (0136), the project's own size too goes with its confirmed number.
    if (multiRatio && (soldUpTo1080 || !(framesChosen.length === 1 && framesChosen[0] === PROJECT_FRAME)))
      return startFrameExports(framesChosen);
    if (dirty || active || starting) return null;
    setStarting(true);
    setError(null);
    setFrameRefusals([]);
    const out = await requestExport(projectId, rev);
    setStarting(false);
    if (!out.ok) {
      if (out.error === "export_needs_quote") setSoldUpTo1080(true);
      setError(out.error);
      return out.error;
    }
    setExports((e) => [
      {
        id: out.value.id,
        rev,
        status: "queued",
        reason: null,
        durationS: total,
        assetId: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      },
      ...e,
    ]);
    return null;
  }

  async function onDelete() {
    const out = await deleteProject(projectId);
    if (!out.ok) {
      setConfirmDelete(false);
      setError(out.error);
      return;
    }
    deleted.current = true;
    loadDocument(path("/editor"));
  }

  // ── tools ─────────────────────────────────────────────────────────────────
  const clip =
    selected?.kind === "clip"
      ? (clips.find((c) => c.id === selected.id) ?? null)
      : null;
  const clipIndex = clip ? clips.findIndex((c) => c.id === clip.id) : -1;
  const text =
    selected?.kind === "text"
      ? (model.texts.find((x) => x.id === selected.id) ?? null)
      : null;
  const sound =
    selected?.kind === "sound"
      ? (model.sounds.find((x) => x.id === selected.id) ?? null)
      : null;
  const overlay =
    selected?.kind === "overlay"
      ? (overlays.find((x) => x.id === selected.id) ?? null)
      : null;
  const shape =
    selected?.kind === "shape"
      ? (shapes.find((x) => x.id === selected.id) ?? null)
      : null;
  const shapeNumber = (id: string) =>
    Math.max(0, shapes.findIndex((x) => x.id === id)) + 1;
  const srcLen = (c: { asset_id: string }) =>
    assets[c.asset_id]?.durationS ?? null;
  /** Only a video has a length an overlay must fit in. */
  const overlaySrc = (c: { asset_id: string }) =>
    isVideoAsset(c.asset_id) ? srcLen(c) : null;
  const overlayNumber = (id: string) =>
    Math.max(0, overlays.findIndex((x) => x.id === id)) + 1;

  function onTrim(
    id: string,
    edge: "in" | "out",
    value: number,
    commit: boolean,
  ) {
    const c = model.clips.find((x) => x.id === id);
    if (!c) return;
    if (!commit) {
      // While dragging: change what is shown, keep one history step for the whole drag.
      if (!dragBase.current) dragBase.current = model;
      setModel(trimLimited(model, id, edge, value, srcLen(c)));
      return;
    }
    apply(trimLimited(model, id, edge, value, srcLen(c)));
  }

  function onTrimEnd() {
    const base = dragBase.current;
    dragBase.current = null;
    if (base && base !== model) {
      setPast((p) => [...p.slice(-(HISTORY - 1)), { model: base, title }]);
      setFuture([]);
    }
  }

  // ── the editing core: roll / slip / slide, marks, ripple trim to the playhead, shuttle ──
  // A picture has no time inside it ("still": any length either way); an unknown length is never guessed.
  const sourceOf = (assetId: string) =>
    assets[assetId]?.kind === "image" ? ("still" as const) : (assets[assetId]?.durationS ?? null);
  const kindOf = (assetId: string) => assets[assetId]?.kind;
  const core = t.editor.core;
  function runTool(base: EditorModel, op: ToolOp): EditorModel {
    if (op.tool === "roll") return rollEdit(base, op.id, op.delta, sourceOf);
    if (op.tool === "slip") return slipClip(base, op.id, op.delta, sourceOf);
    return slideClip(base, op.id, op.delta, sourceOf);
  }
  function onToolEdit(op: ToolOp, commit: boolean) {
    if (!commit) {
      // While dragging: the gesture is measured from where it started, and is one undo step.
      if (!dragBase.current) dragBase.current = model;
      setModel(runTool(dragBase.current, op));
      return;
    }
    const next = runTool(model, op);
    if (next === model) {
      const c = model.clips.find((x) => x.id === op.id);
      setCoreStatus(
        op.tool === "slip" && !slipRange(model, op.id, sourceOf)
          ? c && sourceOf(c.asset_id) === "still"
            ? core.tools.noFileStill
            : core.tools.noFile
          : core.tools.stuck,
      );
      return;
    }
    setCoreStatus(null);
    // A run of arrow keys on one handle is one undo step.
    apply(next, `${op.tool}:${op.id}`);
  }
  function onToolEditEnd() {
    const base = dragBase.current;
    dragBase.current = null;
    if (!base || base === model) return;
    // The drag showed the model unsettled; it ends settled, as an edit through apply does.
    const fixed = settleAll(model, base);
    setSettled(fixed.changes);
    gesture.current = null;
    setPast((p) => [...p.slice(-(HISTORY - 1)), { model: base, title }]);
    setFuture([]);
    if (fixed.model !== model) setModel(fixed.model);
  }
  const range = markedRange(marks, total, model.fps);
  const rangeProblem = (p: RangeProblem) =>
    p === "clips_full"
      ? fmt(core.marks.problem.clips_full, { max: MAX_EDITOR_CLIPS })
      : p === "sounds_full"
        ? fmt(core.marks.problem.sounds_full, { max: MAX_EDITOR_SOUNDS })
        : core.marks.problem[p];
  function onExtract() {
    if (!range) return setCoreStatus(core.marks.problem.no_range);
    const out = extractRange(model, range[0], range[1]);
    if ("problem" in out) return setCoreStatus(rangeProblem(out.problem));
    setPlaying(false);
    apply(out.model);
    setMarks(NO_MARKS);
    setPlayhead(range[0]);
    setCoreStatus(fmt(core.marks.extracted[countForm(out.removed, locale)], { n: out.removed }));
  }
  function onLift() {
    if (!range) return setCoreStatus(core.marks.problem.no_range);
    const out = liftRange(model, range[0], range[1]);
    if ("problem" in out) return setCoreStatus(rangeProblem(out.problem));
    apply(out.model);
    setCoreStatus(core.marks.lifted);
  }
  function onInsert() {
    if (!clipboard) return setCoreStatus(core.marks.noClipboard);
    const out = insertAt(model, clipboard, playhead);
    if ("problem" in out) return setCoreStatus(rangeProblem(out.problem));
    apply(out.model);
    setSelected({ kind: "clip", id: out.id });
    setCoreStatus(core.marks.inserted);
  }
  function onMark(which: "in" | "out") {
    setMarks((m) => setMark(m, which, playhead, model.fps, total));
    setCoreStatus(null);
  }
  function onCore(action: CoreAction) {
    switch (action) {
      case "shuttleBack":
      case "shuttleStop":
      case "shuttleForward": {
        const n = nextShuttle({ playing, rate: shuttle }, action);
        // Nothing to play that way: at the start going back, at the end going forwards.
        if (n.playing && n.rate < 0 && playhead <= 0.001) return;
        if (n.playing && n.rate > 0 && playhead >= total - 0.001) return;
        setShuttle(n.rate);
        setPlaying(n.playing);
        return;
      }
      case "markIn":
      case "markOut":
        return onMark(action === "markIn" ? "in" : "out");
      case "rippleHead":
      case "rippleTail": {
        const out = rippleTrimTo(model, playhead, action === "rippleHead" ? "head" : "tail");
        if (!out) return setCoreStatus(core.ripple.none);
        setPlaying(false);
        apply(out.model);
        setPlayhead(out.playhead);
        setCoreStatus(null);
        return;
      }
      case "extract":
        return onExtract();
      case "lift":
        return onLift();
      case "insert":
        return onInsert();
      case "toolTrim":
        return setTool("trim");
      case "toolRoll":
        return setTool("roll");
      case "toolSlip":
        return setTool("slip");
      case "toolSlide":
        return setTool("slide");
    }
  }

  function onSplit() {
    if (!clip) return;
    const out = splitClip(model, clip.id, playhead);
    if (out) apply(out.model);
  }

  function onAddText() {
    const out = addText(model, playhead < picture ? playhead : 0, te.newText);
    if (!out) return;
    apply(out.model);
    setSelected({ kind: "text", id: out.id });
  }

  // ── "Add to project": a finished AI result, offered once, added only on the press ──
  const [offer, setOffer] = useState<"open" | "added" | "failed" | "noDuration" | "closed">("open");
  const offerStatus = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (offer === "added") offerStatus.current?.focus();
  }, [offer]);
  const offered = offerAssetId
    ? [...videos, ...imageFiles, ...soundFiles].find((a) => a.id.toLowerCase() === offerAssetId.toLowerCase())
    : undefined;
  // A reload with ?add= in the address must not offer a file the project already has (it would be added twice).
  const inModel =
    !!offerAssetId &&
    [...model.clips, ...model.sounds, ...overlays].some((x) => x.asset_id.toLowerCase() === offerAssetId.toLowerCase());
  function onOfferAdd() {
    if (!offered) return;
    // Without a length a video or sound cannot be placed: say that, not "full".
    if (offered.kind !== "image" && !(offered.durationS && offered.durationS > 0)) {
      setOffer("noDuration");
      return;
    }
    let next: EditorModel | null = null;
    let pick: Selection = null;
    if (offered.kind === "audio") {
      const out = addSound(model, offered, playhead < picture ? playhead : 0);
      if (out) {
        next = out.model;
        pick = { kind: "sound", id: out.id };
      }
    } else {
      const m = offered.kind === "video" ? addClip(model, offered) : addStill(model, offered);
      if (m !== model) {
        next = m;
        pick = { kind: "clip", id: m.clips[m.clips.length - 1].id };
      }
    }
    if (!next) {
      setOffer("failed");
      return;
    }
    setAssets((x) => ({ ...x, [offered.id]: offered }));
    apply(next);
    setSelected(pick);
    setOffer("added");
  }

  // "Improve with AI" → Captions: the Captions panel is lower on the page.
  const [captionsFor, setCaptionsFor] = useState<{ id: string; nonce: number } | null>(null);
  function goCaptions(assetId?: string) {
    if (assetId) setCaptionsFor((c) => ({ id: assetId, nonce: (c?.nonce ?? 0) + 1 }));
    const el = document.querySelector<HTMLElement>("[data-captions-panel]");
    el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    el?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (focusPanel === "captions") setTimeout(() => goCaptions(), 0);
    // once, when the editor opens on that panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "Improve with AI" for the file a clip or overlay shows (nothing without an organization to price in). */
  function improveFor(assetId: string, withCaptions: boolean) {
    const a = assets[assetId];
    if (!orgId || !a || !isImproveKind(a.kind)) return null;
    return (
      <ImproveWithAi
        key={assetId}
        assetId={assetId}
        kind={a.kind}
        name={a.name}
        available={aiTools}
        models={aiModels}
        project={projectId}
        onCaptions={withCaptions ? () => goCaptions(assetId) : undefined}
        className={quietBtn}
      />
    );
  }

  function onAddVideo(a: EditorAsset) {
    const next = addClip(model, a);
    if (next === model) return;
    setAssets((x) => ({ ...x, [a.id]: a }));
    apply(next);
    setSelected({ kind: "clip", id: next.clips[next.clips.length - 1].id });
    setAdding(false);
  }

  function onAddSound(a: EditorAsset) {
    const out = addSound(model, a, playhead < picture ? playhead : 0);
    if (!out) return;
    setAssets((x) => ({ ...x, [a.id]: a }));
    apply(out.model);
    setSelected({ kind: "sound", id: out.id });
    setAddingSound(false);
  }

  /** A registered voice-over take, placed like any sound (where the playhead was when "Add" was pressed). */
  function onAddVoiceOver(a: EditorAsset, at: number): boolean {
    const out = addSound(model, a, at);
    if (!out) return false;
    setAssets((x) => ({ ...x, [a.id]: a }));
    apply(out.model);
    setSelected({ kind: "sound", id: out.id });
    return true;
  }

  function onAddOverlay(a: EditorAsset) {
    const out = addOverlay(
      model,
      a,
      playhead < picture ? playhead : 0,
      isVideoAsset,
    );
    if (!out) return;
    setAssets((x) => ({ ...x, [a.id]: a }));
    apply(out.model);
    setSelected({ kind: "overlay", id: out.id });
    setAddingOverlay(false);
    overlayFocus.current = "frame";
  }

  function onAddShape(kind: ShapeKind, label: string) {
    const out = addShape(model, kind, playhead < picture ? playhead : 0, label);
    if (!out) {
      const why = shapeAddCheck(model, kind, playhead < picture ? playhead : 0);
      setShapeRefusal(why === "time" ? "time" : "memory");
      return;
    }
    setShapeRefusal(null);
    apply(out.model);
    setSelected({ kind: "shape", id: out.id });
    setAddingShape(false);
    shapeFocus.current = "frame";
  }

  /** The bar's span: the whole video, or the clip under the playhead. */
  function onShapeSpan(which: "video" | "clip") {
    if (!shape) return;
    const c = which === "clip" ? clipAt(model, Math.min(playhead, Math.max(0, picture - 0.001)))?.clip : undefined;
    const start = c ? c.start_s : 0;
    const end = c ? clipEnd(c) : picture;
    if (end > start) apply(updateShape(model, shape.id, { start_s: start, end_s: end }));
  }

  const audioFull = audioInputs(model) >= MAX_AUDIO_CLIPS;
  const shownTexts = textsAt(model, playhead);
  // "Exports are sold now" is not a failure: the price and its yes appear right below it, so it is said as a note, not an
  // alarm, and the next press of Export is the paid one. The refusal that taught it stays the pinned flow.
  const needsQuote = error === "export_needs_quote" || frameRefusals.some((r) => r.error === "export_needs_quote");
  const errorText =
    error === "text_empty" ? te.textEmpty : error && error !== "export_needs_quote" ? te.errors[error] : null;
  const shownRefusals = frameRefusals.filter((r) => r.error !== "export_needs_quote");
  const exportBlocked = dirty
    ? te.exportNeedsSave
    : active
      ? te.exportBusy
      : soldUpTo1080 && !quoted
        ? te.exportHires.soldNoQuote
        : !multiRatio && ownBlocked
          ? ownBlocked
          : multiRatio && framesChosen.length === 0
            ? (ownBlocked ?? te.exportRatios.none)
            : paidChosen.length > 0 && !paidReady
              ? te.errors.quote_required
              : null;
  /** A size's name for a sentence: the format's, or "this project's size". */
  const frameName = (c: string) =>
    isHiresPresetId(c)
      ? te.exportHires.names[c]
      : isExportPresetId(c)
        ? te.exportPreset.names[c]
        : te.exportRatios.own;
  const when = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ""
      : formatDayTime(d, locale);
  };

  // Words first; the mark (filled = unsaved, hollow = saved) is a second cue, never the only one.
  const saveState = (
    <div className="flex min-w-0 flex-col items-end gap-0.5 text-xs">
      <span
        className={`inline-flex items-center gap-1.5 ${dirty && !saving ? "font-medium text-[var(--color-warn)]" : "text-[var(--color-muted)]"}`}
        aria-live="polite"
      >
        <span
          aria-hidden
          className={`inline-block size-2 shrink-0 rounded-full border border-current ${dirty && !saving ? "bg-current" : ""}`}
        />
        {saving ? te.saving : dirty ? te.unsaved : te.saved}
      </span>
      {dirty && draft.kept ? (
        <span
          className={`text-xs ${draft.kept === "kept" ? "text-[var(--color-muted)]" : "font-medium text-[var(--color-warn)]"}`}
        >
          {draft.kept === "kept" ? te.draftKept : te.draftOff}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4" data-editor-root="">
      {offerAssetId && offer !== "closed" && (offer === "added" || !inModel) ? (
        <section
          aria-label={fmt(t.improveAi.offerTitle, { name: offered?.name ?? t.improveAi.unnamed })}
          className="panel flex flex-col gap-2 p-4 sm:p-5"
          data-testid="offer-add"
        >
          {offer === "added" ? (
            <p ref={offerStatus} tabIndex={-1} role="status" className="m-0 text-sm text-[var(--color-fg)] outline-none">
              {t.improveAi.offerAdded}
            </p>
          ) : !offered ? (
            <p role="status" className="m-0 text-sm text-[var(--color-muted)]">
              {t.improveAi.offerMissing}
            </p>
          ) : (
            <>
              <h2 className="m-0 text-sm font-semibold">
                {fmt(t.improveAi.offerTitle, { name: offered.name ?? t.improveAi.unnamed })}
              </h2>
              <p className="m-0 text-xs text-[var(--color-muted)]">{t.improveAi.offerBody}</p>
              {offer === "failed" || offer === "noDuration" ? (
                <p role="alert" className="m-0 text-sm text-[var(--color-fail)]">
                  {offer === "noDuration" ? t.improveAi.offerNoDuration : t.improveAi.offerFailed}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={onOfferAdd} className="btn-primary text-sm">
                  {t.improveAi.offerAdd}
                </button>
                <button type="button" onClick={() => setOffer("closed")} className={quietBtn}>
                  {t.improveAi.offerNotNow}
                </button>
              </div>
            </>
          )}
          {offer === "added" || !offered ? (
            <div>
              <button type="button" onClick={() => setOffer("closed")} className={quietBtn}>
                {t.improveAi.close}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      {/* header: name, history, save, export */}
      <div className="panel flex flex-col gap-3 p-4 sm:p-5 sm:p-4">
        {/* One grid, placed per breakpoint. From sm up the back link and the saved
            state share the top row, then the name's label and field. On a phone the
            back link is dropped (the breadcrumb's arrow and the Editor tab already
            lead back) and the saved state sits at the end of the name's label. The
            saved state is ONE element (one polite live region), only moved. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-2 gap-y-1 [grid-template-areas:'label_status''input_input'] sm:items-center sm:[grid-template-areas:'back_status''label_label''input_input']">
          <Link
            href={path("/editor")}
            className="hidden text-sm text-[var(--color-primary)] underline-offset-4 [grid-area:back] hover:underline sm:inline sm:[@media(pointer:coarse)]:flex sm:[@media(pointer:coarse)]:min-h-11 sm:[@media(pointer:coarse)]:items-center"
          >
            ← {te.back}
          </Link>
          <div className="[grid-area:status]">{saveState}</div>
          <label
            htmlFor={`${ids}-title`}
            className="text-xs text-[var(--color-muted)] [grid-area:label] sm:mt-2 sm:self-end"
          >
            {te.projectTitle}
          </label>
          <input
            id={`${ids}-title`}
            value={title}
            maxLength={120}
            onChange={(e) => {
              const next = e.target.value;
              if (next === title) return;
              if (gesture.current !== "title") {
                setPast((p) => [...p.slice(-(HISTORY - 1)), { model, title }]);
              }
              setFuture([]);
              gesture.current = "title";
              burst.current = null;
              setTitle(next);
              setError(null);
            }}
            onBlur={() => {
              if (gesture.current === "title") gesture.current = null;
            }}
            className={`${fieldClass} [grid-area:input]`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Undo and Redo: a 50/50 pair on a phone (their labels are long in Russian and Uzbek), as Save and Export are below. */}
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            <button
              type="button"
              onClick={undo}
              disabled={!past.length}
              className={quietBtn}
            >
              <Undo2 className="size-3.5" aria-hidden />
              {te.undo}
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!future.length}
              className={quietBtn}
            >
              <Redo2 className="size-3.5" aria-hidden />
              {te.redo}
            </button>
          </div>
          <span className="hidden flex-1 sm:block" />
          {/* Save and Export: one row on a phone (Save as wide as its word, Export takes the rest), so both are on the first screen. */}
          <div className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 sm:flex sm:w-auto">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="btn-quiet text-sm"
            >
              {saving ? te.saving : te.save}
            </button>
            <button
              type="button"
              onClick={() => void startExport()}
              disabled={Boolean(exportBlocked) || starting}
              aria-describedby={exportBlocked ? `${ids}-export-why` : undefined}
              className="btn-primary text-sm"
            >
              {starting ? te.exporting : te.export}
            </button>
          </div>
        </div>
        {exportBlocked ? (
          <p
            id={`${ids}-export-why`}
            className="m-0 text-xs text-[var(--color-muted)]"
          >
            {exportBlocked}
          </p>
        ) : null}
        <ExportPresetPicker
          width={model.width}
          height={model.height}
          fps={model.fps}
          totalS={total}
          onChange={(id) => apply(applyExportPreset(model, id))}
          onFps={(fps) => apply(setExportFps(model, fps))}
        />
        {multiRatio ? (
          <ExportRatioPicker
            width={model.width}
            height={model.height}
            totalS={total}
            choices={frameChoices}
            selected={framesChosen}
            blocked={frameBlocked}
            overCap={frameOverCap}
            tooFast={frameTooFast}
            fps={model.fps}
            ownBlocked={ownBlocked}
            onChange={setFrames}
          />
        ) : null}
        {quoted && paidChosen.length > 0 ? (
          <HiresExportQuote projectId={projectId} rev={rev} dirty={dirty} frames={paidChosen} onChange={setPaidOk} />
        ) : null}
        {needsQuote ? (
          <p role="status" className="m-0 break-words text-sm" data-export-needs-quote="">
            {te.errors.export_needs_quote}
          </p>
        ) : null}
        {shownRefusals.length ? (
          <div role="alert" className="flex flex-col gap-1 text-sm text-[var(--color-fail)]">
            {shownRefusals.map((r) => (
              <p key={r.frame} className="m-0 break-words">
                {fmt(te.exportRatios.refused, {
                  name: frameName(r.frame),
                  // "Not available" for a SIZE has its own sentence: the plain export still works.
                  reason: r.error === "not_available" && r.frame !== PROJECT_FRAME ? te.exportRatios.notAvailable : te.errors[r.error],
                })}
              </p>
            ))}
          </div>
        ) : null}
        <RenderBudgetNotice model={model} />
        <SettleNotice changes={settled} />
        <p className="m-0 hidden text-xs text-[var(--color-muted)] sm:block">
          {soldUpTo1080 ? te.soldNote : te.freeNote} {te.publishNote}
        </p>
        {errorText ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-fail)]"
          >
            <span>{errorText}</span>
            {error === "stale_revision" ? (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className={quietBtn}
              >
                {te.reload}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {multiRatio ? (
        // One panel per size of the newest exported version: each size is its own export with its own file.
        latestPerFrame(exports).map((x) => {
          const choice = exportFrameChoice(x);
          const off = frameMismatch(x, x.assetId ? assets[x.assetId] : undefined);
          return (
            <ExportStatusPanel
              key={x.id}
              latest={x}
              assets={assets}
              currentRev={rev}
              dirty={dirty}
              busy={starting || active}
              failing={poll.failing}
              halt={poll.halt}
              checking={poll.checking}
              // The SAME size again; a size that is no longer on the list is never retried as the project's.
              onRetry={() => startFrameExports(isExportFrameChoice(choice) ? [choice] : [])}
              onCheckNow={poll.checkNow}
              quietRetry={draft.resume.kind === "restore"}
              captions={(captionsOf(model)?.cues.length ?? 0) > 0}
              heading={fmt(te.exportRatios.panelFor, {
                name: x.frame
                  ? `${frameName(choice)} · ${fmt(te.exportRatios.size, { w: x.frame.width, h: x.frame.height })}`
                  : te.exportRatios.own,
              })}
              notice={
                off && x.frame
                  ? fmt(te.exportRatios.mismatch, { w: off.width, h: off.height, fw: x.frame.width, fh: x.frame.height })
                  : null
              }
            />
          );
        })
      ) : exports[0] ? (
        <ExportStatusPanel
          latest={exports[0]}
          assets={assets}
          currentRev={rev}
          dirty={dirty}
          busy={starting || active}
          failing={poll.failing}
          halt={poll.halt}
          checking={poll.checking}
          onRetry={startExport}
          onCheckNow={poll.checkNow}
          quietRetry={draft.resume.kind === "restore"}
          captions={(captionsOf(model)?.cues.length ?? 0) > 0}
        />
      ) : null}

      <DraftBanner
        resume={draft.resume}
        onRestore={draft.restore}
        onDiscard={draft.discard}
      />

      {/* Below lg this is one column, so the left column dissolves (`contents`)
          and the preview becomes a child of the flex column that also holds the
          inspector: a pinned child stays pinned all the way down the inspector,
          where the colour sliders are. From lg the two columns sit side by side. */}
      <div className="flex min-w-0 flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-4">
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-3">
          {/* preview: pinned under the top bar below lg, capped to 30dvh (the box keeps its ratio, see previewFrameStyle) */}
          <div
            ref={pinned}
            className="sticky top-[var(--ns-header-h,4rem)] z-10 bg-[var(--color-bg)] pb-2 pt-1 [--ns-preview-cap:30dvh] lg:static lg:bg-transparent lg:p-0 lg:[--ns-preview-cap:60vh] [@media(max-height:32rem)]:static [@media(max-height:32rem)]:bg-transparent [@media(max-height:32rem)]:p-0 [@media(max-height:32rem)]:[--ns-preview-cap:60vh]"
            data-editor-preview-pin=""
          >
          <div
            className="relative mx-auto w-full overflow-hidden rounded-[var(--ns-r-panel)] border border-[var(--color-border)] bg-black"
            style={previewFrameStyle(model)}
          >
            <GradeFilterDefs clip={at?.clip} still={still} />
            <LookFilterDefs clip={at?.clip} />
            {src ? (
              <ClipPicture
                clip={at?.clip}
                still={still}
                src={src}
                frame={model}
                source={at ? (assets[at.clip.asset_id] ?? null) : null}
                progress={at ? (playhead - at.clip.start_s) / Math.max(0.001, clipLength(at.clip)) : 0}
                videoRef={video}
                onLoadedMetadata={() => {
                  const v = video.current;
                  if (v && at) {
                    v.currentTime = at.sourceS;
                    setRate(v, shuttleRateFor(at.clip.speed, shuttle));
                    if (playing)
                      void v.play?.()?.catch?.(() => setPlaying(false));
                  }
                }}
                onError={() => {
                  // A ten-minute link expired: ask once for fresh ones.
                  if (!refreshed.current) {
                    refreshed.current = true;
                    void refreshLinks();
                  }
                }}
              />
            ) : !at && clips.length && playhead < picture ? null : (
              // In a gap (a lift's black) the frame is black, as the export renders it; this note is for a missing picture.
              <p className="absolute inset-0 m-0 flex items-center justify-center p-4 text-center text-xs text-[var(--ns-on-film)]">
                {te.noPreview}
              </p>
            )}
            {overlays.length ? (
              <OverlayLayer
                  overlays={overlaysAt(model, playhead)}
                  assets={assets}
                  selectedId={overlay?.id ?? null}
                  numberOf={overlayNumber}
                  playhead={playhead}
                  playing={playing}
                  frame={model}
                  onNudge={(id, dx, dy, big) =>
                    applyBurst(
                      nudgeOverlay(model, id, dx, dy, big ? 0.05 : 0.01),
                      `${id}:nudge`,
                    )
                  }
                  onDrag={(id, x, y) => {
                    if (!dragBase.current) dragBase.current = model;
                    setModel(updateOverlay(model, id, { x, y }));
                  }}
                  onDragEnd={onTrimEnd}
                  onLinkError={() => {
                    if (!refreshed.current) {
                      refreshed.current = true;
                      void refreshLinks();
                    }
                  }}
              />
            ) : null}
            {shapes.length ? (
              <ShapeLayerView
                shapes={shapesAt(model, playhead)}
                selectedId={shape?.id ?? null}
                numberOf={shapeNumber}
                playhead={playhead}
                frame={model}
                fps={model.fps}
                onNudge={(id, dx, dy, big) =>
                  applyBurst(nudgeShape(model, id, dx, dy, big ? 0.05 : 0.01), `${id}:nudge`)
                }
                onDrag={(id, x, y) => {
                  if (!dragBase.current) dragBase.current = model;
                  setModel(updateShape(model, id, { x, y }));
                }}
                onDragEnd={onTrimEnd}
              />
            ) : null}
            {cuesAt(model, playhead).map((c) => {
              const st = captionsOf(model)?.style;
              // An animated style has its own approximate preview; a plain caption keeps the one it always had.
              if (st && isCaptionStyleId(st.preset)) {
                return (
                  <CaptionPreview
                    key={c.id}
                    cue={c}
                    style={st}
                    playhead={playhead}
                    frameWidth={model.width}
                    perWord={perWordCueIds(captionsOf(model)?.cues ?? []).has(c.id)}
                  />
                );
              }
              return st ? (
                <span
                  key={c.id}
                  className="pointer-events-none absolute whitespace-pre-wrap text-center leading-tight"
                  style={{
                    left: "50%",
                    top: `${st.y * 100}%`,
                    transform: "translate(-50%, -100%)",
                    maxWidth: "92%",
                    fontSize: `${(st.size / model.width) * 100}cqw`,
                    fontWeight: st.bold ? 700 : 400,
                    color: st.color,
                    textShadow: `0 0 2px ${st.outline_color}, 0 0 2px ${st.outline_color}, 0 0 3px ${st.outline_color}`,
                  }}
                >
                  {c.text}
                </span>
              ) : null;
            })}
            {shownTexts.map((x) => {
              const f = animFrame(x, playhead);
              // A typewriter keeps the final position: the unwritten rest is there, unseen.
              const body =
                f.written === null ? (
                  x.text
                ) : (
                  <>
                    {writtenText(x.text, f.written)}
                    <span style={{ visibility: "hidden" }}>
                      {x.text.slice(writtenText(x.text, f.written).length)}
                    </span>
                  </>
                );
              return (
                <span
                  key={x.id}
                  className="pointer-events-none absolute whitespace-pre-wrap text-center leading-tight"
                  style={textBoxStyle(x, model, f)}
                >
                  {x.box_color ? (
                    <span style={previewBoxStyle(x, model.width)}>{body}</span>
                  ) : (
                    body
                  )}
                </span>
              );
            })}
            <PreviewGuides frame={model} value={guides} />
          </div>
          </div>
          <p className="m-0 text-center text-xs text-[var(--color-muted)]">
            {te.previewNote}
            {model.sounds.length ? ` ${te.soundPreviewNote}` : ""}
            {overlays.length ? ` ${te.overlay.previewNote}` : ""}
            {shapes.length ? ` ${te.shapes.previewNote}` : ""}
            {at && !playsNatively(at.clip) ? ` ${te.fx.speed.previewNote}` : ""}
            {isCaptionStyleId(captionsOf(model)?.style.preset)
              ? ` ${t.captions.animated.previewNote}`
              : ""}
          </p>
          <CaptionReviewHints cues={captionsOf(model)?.cues ?? []} pictureEnd={picture} />
          {/* The header panel's note about free export and nothing being published, here below the picture on a phone so the controls above start higher. */}
          <p className="m-0 text-center text-xs text-[var(--color-muted)] sm:hidden">
            {soldUpTo1080 ? te.soldNote : te.freeNote} {te.publishNote}
          </p>
          <FramePicker
            width={model.width}
            height={model.height}
            onChange={(id) => apply(setFrame(model, id))}
          />
          <GuidesControls
            frame={model}
            value={guides}
            onChange={(g) => {
              setGuides(g);
              saveGuides(g);
            }}
          />
          <SoundPreview
            sounds={model.sounds}
            assets={assets}
            playhead={playhead}
            playing={playing && shuttle === 1}
            speech={speech}
          />

          {/* transport */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? te.pause : te.play}
              className="btn-primary inline-flex size-11 items-center justify-center p-0"
            >
              {playing ? (
                <Pause className="size-4" aria-hidden />
              ) : (
                <Play className="size-4" aria-hidden />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(total, 0.001)}
              step={1 / model.fps}
              value={Math.min(playhead, total)}
              {...scrub}
              aria-label={te.playhead}
              aria-valuetext={fmt(te.timeOf, {
                now: formatTime(playhead),
                total: formatTime(total),
              })}
              className="h-11 min-w-[9rem] flex-1 accent-[var(--color-primary)]"
            />
            {/* The master-control readout: frame-accurate timecode at the project's rate; the spoken form keeps tenths. */}
            {playing && shuttle !== 1 ? (
              <span role="status" className="ns-chip shrink-0 text-xs font-semibold" data-testid="shuttle-rate" title={core.shuttle.note}>
                {fmt(shownShuttle < 0 ? core.shuttle.back : core.shuttle.forward, { x: Math.abs(shownShuttle) })}
              </span>
            ) : null}
            <span className="shrink-0 basis-full text-right text-xs text-[var(--color-muted)] sm:basis-auto">
              <Timecode value={playhead} format="frames" fps={model.fps} label={formatTime(playhead)} /> /{" "}
              <Timecode value={total} format="frames" fps={model.fps} label={formatTime(total)} />
            </span>
          </div>

          <TimelineViewBar view={view} />
          <ToolPicker tool={tool} onTool={setTool} />
          <TimelineStrip
            tool={tool}
            marks={marks}
            onToolEdit={onToolEdit}
            onToolEditEnd={onToolEditEnd}
            onCloseGap={(id) => apply(closeGap(model, id))}
            view={view}
            clips={clips}
            texts={model.texts}
            sounds={model.sounds}
            overlays={overlays}
            shapes={shapes}
            total={total}
            fps={model.fps}
            playhead={playhead}
            selected={selected}
            assets={assets}
            onSelect={setSelected}
            onTrim={onTrim}
            onTrimEnd={onTrimEnd}
            beats={model.sounds.flatMap((x) => (beatsBySound[x.id] ? beatTimes(x, beatsBySound[x.id]) : []))}
          />
          <MarksBar
            range={range}
            marks={marks}
            canInsert={Boolean(clipboard) && model.clips.length < MAX_EDITOR_CLIPS}
            status={coreStatus}
            onMark={onMark}
            onClear={() => {
              setMarks(NO_MARKS);
              setCoreStatus(null);
            }}
            onExtract={onExtract}
            onLift={onLift}
            onInsert={onInsert}
          />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setAdding((a) => !a)}
              aria-expanded={adding}
              disabled={model.clips.length >= MAX_EDITOR_CLIPS}
              className={quietBtn}
            >
              <Plus className="size-3.5" aria-hidden />
              {te.addVideo}
            </button>
            <button
              type="button"
              onClick={() => setAddingSound((a) => !a)}
              aria-expanded={addingSound}
              disabled={!canAddSound(model)}
              className={quietBtn}
            >
              <Music className="size-3.5" aria-hidden />
              {te.addSound}
            </button>
            {orgId ? (
              <button
                type="button"
                onClick={() => setRecordingVoice((v) => !v)}
                aria-expanded={recordingVoice}
                className={quietBtn}
              >
                <Mic className="size-3.5" aria-hidden />
                {te.voiceOver.open}
              </button>
            ) : null}
            <button
              type="button"
              ref={addOverlayButton}
              onClick={() => setAddingOverlay((a) => !a)}
              aria-expanded={addingOverlay}
              disabled={!canAddOverlay(model)}
              aria-describedby={
                canAddOverlay(model) ? undefined : `${ids}-overlay-full`
              }
              className={quietBtn}
            >
              <Layers className="size-3.5" aria-hidden />
              {te.overlay.add}
            </button>
            <button
              type="button"
              ref={addShapeButton}
              onClick={() => setAddingShape((a) => !a)}
              aria-expanded={addingShape}
              disabled={!canAddShape(model)}
              aria-describedby={
                canAddShape(model) ? undefined : `${ids}-shape-full`
              }
              className={quietBtn}
            >
              <Shapes className="size-3.5" aria-hidden />
              {te.shapes.add}
            </button>
            <button
              type="button"
              onClick={onAddText}
              disabled={model.texts.length >= MAX_EDITOR_TEXTS}
              className={quietBtn}
            >
              <Type className="size-3.5" aria-hidden />
              {te.addText}
            </button>
          </div>
          {!canAddOverlay(model) ? (
            <p
              id={`${ids}-overlay-full`}
              role="status"
              className="m-0 text-xs text-[var(--color-muted)]"
            >
              {overlays.length >= MAX_OVERLAYS
                ? fmt(te.overlay.full, { max: MAX_OVERLAYS })
                : overlays.length + shapes.length >= MAX_OVERLAYS
                  ? fmt(te.shapes.layersFull, { max: MAX_OVERLAYS })
                  : te.shapes.pictureMemory}
            </p>
          ) : !canAddOverlay(model, "video", isVideoAsset) ? (
            <p className="m-0 text-xs text-[var(--color-muted)]">
              {fmt(te.overlay.videosFull, { max: MAX_OVERLAY_VIDEOS })}
            </p>
          ) : null}
          {!canAddShape(model) ? (
            <p
              id={`${ids}-shape-full`}
              role="status"
              className="m-0 text-xs text-[var(--color-muted)]"
            >
              {shapes.length >= MAX_SHAPES
                ? fmt(te.shapes.shapesFull, { max: MAX_SHAPES })
                : fmt(te.shapes.layersFull, { max: MAX_OVERLAYS })}
            </p>
          ) : null}
          {shapeRefusal ? (
            <p role="status" className="m-0 text-xs text-[var(--color-warn)]" data-testid="shape-refused">
              {shapeRefusal === "memory"
                ? fmt(te.shapes.budgetMemory, {
                    need: Math.round(shapeBudget(model).memory / 1048576),
                    max: Math.round(shapeBudget(model).memoryMax / 1048576),
                  })
                : fmt(te.shapes.budgetTime, {
                    work: Math.round(shapeBudget(model).work),
                    length: Math.round(total),
                    allowed: Math.round(shapeBudget(model).workMax),
                  })}
            </p>
          ) : null}
          {addingShape ? (
            <ShapePicker onAdd={onAddShape} onClose={() => { setAddingShape(false); setShapeRefusal(null); }} />
          ) : null}
          {addingOverlay ? (
            <OverlayPicker
              images={imageFiles}
              videos={
                canAddOverlay(model, "video", isVideoAsset) ? videos : []
              }
              onPick={onAddOverlay}
              onClose={() => setAddingOverlay(false)}
            />
          ) : null}
          {model.sounds.length >= MAX_EDITOR_SOUNDS ? (
            <p className="m-0 text-xs text-[var(--color-muted)]">
              {fmt(te.maxSounds, { max: MAX_EDITOR_SOUNDS })}
            </p>
          ) : audioFull ? (
            <p className="m-0 text-xs text-[var(--color-muted)]">
              {fmt(te.audioFull, { max: MAX_AUDIO_CLIPS })}
            </p>
          ) : null}
          {recordingVoice && orgId ? (
            <VoiceOverRecorder
              orgId={orgId}
              canAdd={canAddSound(model)}
              position={() => (playhead < picture ? playhead : 0)}
              onAdd={onAddVoiceOver}
              onClose={() => setRecordingVoice(false)}
            />
          ) : null}
          {addingSound ? (
            <section
              aria-label={te.addSoundTitle}
              className="panel flex flex-col gap-2 p-4 sm:p-5"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="m-0 text-sm font-semibold">
                  {te.addSoundTitle}
                </h3>
                <button
                  type="button"
                  onClick={() => setAddingSound(false)}
                  className={quietBtn}
                >
                  {te.close}
                </button>
              </div>
              {soundFiles.length === 0 ? (
                <p className="m-0 text-xs text-[var(--color-muted)]">
                  {te.noSounds}{" "}
                  <Link
                    href={path("/library")}
                    className="text-[var(--color-primary)] underline-offset-4 hover:underline"
                  >
                    {te.openLibrary}
                  </Link>
                </p>
              ) : (
                <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
                  {soundFiles.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => onAddSound(a)}
                        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-2 text-left text-xs"
                      >
                        <span className="truncate text-[var(--color-fg)]">
                          {a.name ?? te.untitledSound}
                        </span>
                        <span className="shrink-0 text-[var(--color-muted)]">
                          <Timecode value={a.durationS} format="duration" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          {model.clips.length >= MAX_EDITOR_CLIPS ? (
            <p className="m-0 text-xs text-[var(--color-muted)]">
              {fmt(te.maxClips, { max: MAX_EDITOR_CLIPS })}
            </p>
          ) : null}
          {model.texts.length >= MAX_EDITOR_TEXTS ? (
            <p className="m-0 text-xs text-[var(--color-muted)]">
              {fmt(te.maxTexts, { max: MAX_EDITOR_TEXTS })}
            </p>
          ) : null}
          {adding ? (
            <section
              aria-label={te.addVideoTitle}
              className="panel flex flex-col gap-2 p-4 sm:p-5"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="m-0 text-sm font-semibold">
                  {te.addVideoTitle}
                </h3>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className={quietBtn}
                >
                  {te.close}
                </button>
              </div>
              {videos.length === 0 ? (
                <p className="m-0 text-xs text-[var(--color-muted)]">
                  {te.noVideos}
                </p>
              ) : (
                <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3">
                  {videos.map((v) => (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => onAddVideo(v)}
                        className="flex w-full min-w-0 flex-col gap-1 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-2 text-left text-xs"
                      >
                        <span className="truncate text-[var(--color-fg)]">
                          {v.name ?? te.untitledVideo}
                        </span>
                        <span className="text-[var(--color-muted)]">
                          <Timecode value={v.durationS} format="duration" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>

        {/* inspector */}
        <aside
          className="panel flex min-w-0 flex-col gap-3 p-5 sm:p-6"
          aria-label={
            clip
              ? te.trim
              : text
                ? te.textLabel
                : sound
                  ? te.soundHeading
                  : overlay
                    ? fmt(te.overlay.heading, {
                        n: overlayNumber(overlay.id),
                      })
                    : shape
                      ? fmt(te.shapes.heading, {
                          n: shapeNumber(shape.id),
                          kind: te.shapes.kinds[shape.kind],
                        })
                      : te.timeline
          }
        >
          {shape ? (
            <ShapeInspector
              key={shape.id}
              n={shapeNumber(shape.id)}
              total={shapes.length}
              shape={shape}
              warning={shapeWarns[shape.id] ?? null}
              budgetPct={Math.round(
                100 *
                  Math.max(
                    shapeBudget(model).memory / shapeBudget(model).memoryMax,
                    shapeBudget(model).work / shapeBudget(model).workMax,
                  ),
              )}
              onChange={(patch, key) => {
                const next = updateShape(model, shape.id, patch);
                if (key) applyBurst(next, key);
                else apply(next);
              }}
              onKind={(k) => apply(setShapeKind(model, shape.id, k, te.shapes.labels.subscribe))}
              onSpan={onShapeSpan}
              onReset={() => apply(resetShape(model, shape.id))}
              onToPlayhead={() =>
                apply(updateShape(model, shape.id, { start_s: playhead }))
              }
              onLayer={(by) => apply(moveShape(model, shape.id, by))}
              extra={
                <>
                  <ShapeMoveSection model={model} shape={shape} apply={apply} />
                  <ShapeAnimSection model={model} shape={shape} apply={apply} />
                </>
              }
              onDelete={() => {
                shapeFocus.current = "add";
                apply(removeShape(model, shape.id));
              }}
            />
          ) : overlay ? (
            <>
            <OverlayInspector
              key={overlay.id}
              n={overlayNumber(overlay.id)}
              total={overlays.length}
              overlay={overlay}
              name={assets[overlay.asset_id]?.name ?? te.overlay.untitled}
              kind={assets[overlay.asset_id]?.kind ?? "image"}
              warning={overlayWarns[overlay.id] ?? null}
              onChange={(patch, key) => {
                const next = updateOverlay(
                  model,
                  overlay.id,
                  patch,
                  overlaySrc(overlay),
                );
                if (key) applyBurst(next, key);
                else apply(next);
              }}
              onReset={() => apply(resetOverlay(model, overlay.id))}
              onToPlayhead={() =>
                apply(
                  updateOverlay(
                    model,
                    overlay.id,
                    { start_s: playhead },
                    overlaySrc(overlay),
                  ),
                )
              }
              onLayer={(by) => apply(moveOverlay(model, overlay.id, by))}
              extra={
                <>
                  <OverlayMoveSection model={model} overlay={overlay} apply={apply} />
                  <OverlayAnimSection model={model} overlay={overlay} apply={apply} />
                  <OverlayChromaSection model={model} overlay={overlay} apply={apply} />
                </>
              }
              onDelete={() => {
                overlayFocus.current = "add";
                apply(removeOverlay(model, overlay.id));
              }}
            />
            {improveFor(overlay.asset_id, false)}
            </>
          ) : sound ? (
            <SoundInspector
              key={sound.id}
              sound={sound}
              name={assets[sound.asset_id]?.name ?? te.untitledSound}
              sourceS={srcLen(sound)}
              warning={soundWarns[sound.id] ?? null}
              hasSpeech={speech.length > 0}
              onChange={(patch) =>
                apply(updateSound(model, sound.id, patch, srcLen(sound)))
              }
              onToPlayhead={() =>
                apply(
                  updateSound(
                    model,
                    sound.id,
                    { start_s: playhead },
                    srcLen(sound),
                  ),
                )
              }
              onFit={() => apply(fitSoundToPicture(model, sound.id))}
              clean={
                <>
                  <SoundCleanSection model={model} sound={sound} apply={apply} />
                  <SoundBeatsSection
                    sound={sound}
                    asset={assets[sound.asset_id]}
                    shown={beatsBySound[sound.id] ?? null}
                    onBeats={(id, beats) =>
                      setBeatsBySound((b) => {
                        const next = { ...b };
                        if (beats) next[id] = beats;
                        else delete next[id];
                        return next;
                      })
                    }
                  />
                </>
              }
              onDelete={() => apply(removeSound(model, sound.id))}
            />
          ) : clip ? (
            <>
            <ClipInspector
              key={clip.id}
              n={clipIndex + 1}
              clip={clip}
              sourceS={srcLen(clip)}
              canSplitHere={canSplit(model, clip.id, playhead)}
              onlyClip={model.clips.length <= 1}
              first={clipIndex === 0}
              last={clipIndex === clips.length - 1}
              onIn={(v) =>
                apply(trimLimited(model, clip.id, "in", v, srcLen(clip)))
              }
              onOut={(v) =>
                apply(trimLimited(model, clip.id, "out", v, srcLen(clip)))
              }
              speed={
                <ClipSpeedSection
                  model={model}
                  clip={clip}
                  still={assets[clip.asset_id]?.kind === "image"}
                  playhead={playhead}
                  apply={apply}
                  showClip={showClip}
                  onFrozen={(newId) => setSelected({ kind: "clip", id: newId })}
                />
              }
              fit={fitOf(clip)}
              still={assets[clip.asset_id]?.kind === "image"}
              onFit={(f) => apply(setClipFit(model, clip.id, f))}
              grade={gradeOf(clip)}
              onGrade={(patch, group) => {
                apply(setClipGrade(model, clip.id, patch), group);
                showClip(clip.id);
              }}
              onGradeReset={() => {
                apply(resetClipGrade(model, clip.id));
                showClip(clip.id);
              }}
              fx={
                <ClipFxSections
                  model={model}
                  clip={clip}
                  source={assets[clip.asset_id] ?? null}
                  still={assets[clip.asset_id]?.kind === "image"}
                  apply={apply}
                  showClip={showClip}
                />
              }
              onAudio={(a) => apply(setClipAudio(model, clip.id, a))}
              audioLocked={(!clip.audio && audioFull) || Boolean(clip.freeze)}
              sound={
                <ClipVolumeDetach
                  model={model}
                  clip={clip}
                  assetKind={assets[clip.asset_id]?.kind}
                  apply={apply}
                  onDetached={(soundId) => setSelected({ kind: "sound", id: soundId })}
                />
              }
              copy={
                <>
                  <ClipCopyTools
                    model={model}
                    clip={clip}
                    clipboard={clipboard}
                    onCopy={setClipboard}
                    apply={apply}
                    onInserted={(newId) => setSelected({ kind: "clip", id: newId })}
                  />
                  {clipIndex > 0 ? (
                    <SplitEditTools
                      model={model}
                      clipId={clip.id}
                      sourceOf={sourceOf}
                      kindOf={kindOf}
                      apply={apply}
                      onDone={() => undefined}
                    />
                  ) : null}
                </>
              }
              crossfade={crossfadeOf(clip)}
              maxCrossfade={maxCrossfade(model, clip.id)}
              onCrossfade={(d) => apply(setCrossfade(model, clip.id, d))}
              crossfadeStyle={crossfadeStyleOf(clip)}
              onCrossfadeStyle={(s) =>
                apply(setCrossfadeStyle(model, clip.id, s))
              }
              onCrossfadeAll={() => {
                const r = applyCrossfadeToAll(model, clip.id);
                const ta = t.editor.parity2b.transitionAll;
                if (r.changed) apply(r.model);
                setCrossfadeAllNote(r.changed ? fmt(ta.done[countForm(r.changed, locale)], { n: r.changed }) : ta.none);
              }}
              crossfadeAllNote={crossfadeAllNote}
              onSplit={onSplit}
              onMove={(by) => apply(moveClip(model, clip.id, by))}
              onDelete={() => apply(removeClip(model, clip.id))}
            />
            {improveFor(clip.asset_id, true)}
            </>
          ) : text ? (
            <TextInspector
              key={text.id}
              text={text}
              warning={warnings[text.id] ?? null}
              onChange={(patch) => apply(updateText(model, text.id, patch))}
              onLook={(look) => apply(applyTextLook(model, text.id, look))}
              anim={<TextAnimSection model={model} text={text} apply={apply} />}
              onDelete={() => apply(removeText(model, text.id))}
            />
          ) : (
            <p className="m-0 text-sm text-[var(--color-muted)]">
              {te.selectHint}
            </p>
          )}
        </aside>
      </div>

      {/* auto-captions: the transcript is the one paid step (0072); the rest is free */}
      <CaptionsPanel
        orgId={orgId}
        projectTitle={title}
        model={model}
        assets={assets}
        models={captionModels}
        modelsStatus={captionModelsStatus}
        pictureEnd={picture}
        onChange={apply}
        preselect={captionsFor}
      />

      {/* earlier exports (the latest one is the status panel above) */}
      {exports.length > 1 ? (
        <section
          aria-labelledby={`${ids}-exports`}
          className="panel flex flex-col gap-2 p-5 sm:p-6"
        >
          <h2 id={`${ids}-exports`} className="m-0 text-[15px] font-semibold">
            {te.exports}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {exports.slice(1).map((x) => {
              const out = x.assetId ? assets[x.assetId] : undefined;
              const tone =
                x.status === "done"
                  ? "text-[var(--color-ok)]"
                  : x.status === "failed"
                    ? "text-[var(--color-fail)]"
                    : "text-[var(--color-warn)]";
              return (
                <li
                  key={x.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border)] pt-2 text-sm first:border-t-0 first:pt-0"
                >
                  <span className={`font-semibold ${tone}`}>
                    {te.exportStatus[x.status]}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {fmt(te.exportRev, { rev: x.rev })}
                    {x.durationS ? (
                      <>
                        {" · "}
                        <Timecode value={x.durationS} format="duration" />
                      </>
                    ) : null}
                    {x.createdAt ? (
                      // The server and the browser format a UZ date differently.
                      <span suppressHydrationWarning>{` · ${when(x.createdAt)}`}</span>
                    ) : null}
                  </span>
                  {x.status === "failed" ? (
                    <span className="w-full text-xs text-[var(--color-fail)]">
                      {te.exportReasons[x.reason ?? "other"]}
                    </span>
                  ) : null}
                  {x.status === "done" ? (
                    <span className="flex flex-wrap gap-3">
                      {out?.viewUrl ? (
                        <a
                          href={out.viewUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-h-11 items-center text-[var(--color-primary)] underline-offset-4 hover:underline"
                        >
                          {te.watch}
                        </a>
                      ) : null}
                      <Link
                        href={path("/library")}
                        className="inline-flex min-h-11 items-center text-[var(--color-primary)] underline-offset-4 hover:underline"
                      >
                        {te.viewInLibrary}
                      </Link>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>

        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {confirmDelete ? (
          <div
            role="group"
            aria-label={te.deleteProject}
            className="panel flex flex-wrap items-center gap-2 p-4 sm:p-5 text-sm"
          >
            <span>{te.deleteConfirm}</span>
            <button
              type="button"
              onClick={() => void onDelete()}
              className="btn-primary text-xs"
            >
              {te.deleteYes}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className={quietBtn}
            >
              {te.cancel}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className={`${quietBtn} text-[var(--color-fail)]`}
          >
            <Trash2 className="size-3.5" aria-hidden />
            {te.deleteProject}
          </button>
        )}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft.replace(",", "."));
    if (Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-muted)]">
      {label}
      <input
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className={fieldClass}
      />
    </label>
  );
}

function ClipInspector({
  n,
  clip,
  sourceS,
  canSplitHere,
  onlyClip,
  first,
  last,
  onIn,
  onOut,
  speed,
  fit,
  still,
  onFit,
  grade,
  onGrade,
  onGradeReset,
  fx,
  onAudio,
  audioLocked,
  sound,
  copy,
  crossfade,
  maxCrossfade: maxX,
  onCrossfade,
  crossfadeStyle,
  onCrossfadeStyle,
  onCrossfadeAll,
  crossfadeAllNote,
  onSplit,
  onMove,
  onDelete,
}: {
  n: number;
  clip: VideoClip;
  sourceS: number | null;
  canSplitHere: boolean;
  onlyClip: boolean;
  first: boolean;
  last: boolean;
  onIn: (v: number) => void;
  onOut: (v: number) => void;
  /** The speed, direction, freeze, curve and slow-motion controls (ClipSpeedSection). */
  speed?: ReactNode;
  fit: Fit;
  /** A picture always fills the frame in the export: no fit to choose. */
  still: boolean;
  onFit: (fit: Fit) => void;
  grade: ClipGrade;
  onGrade: (patch: Partial<ClipGrade>, group: string) => void;
  onGradeReset: () => void;
  /** The look, effects, crop and tilt sections (ClipFxSections). */
  fx?: ReactNode;
  onAudio: (a: boolean) => void;
  audioLocked: boolean;
  /** The clip's own sound: volume and "Detach audio" (ClipVolumeDetach). */
  sound?: ReactNode;
  /** Duplicate / copy / paste (ClipCopyTools). */
  copy?: ReactNode;
  /** The cross-fade into this clip in seconds (0 = a cut). */
  crossfade: number;
  /** The longest it can be (0 = this clip cannot have one). */
  maxCrossfade: number;
  onCrossfade: (seconds: number) => void;
  /** How the previous clip blends into this one (`fade` = the plain blend). */
  crossfadeStyle: XfadeStyle;
  onCrossfadeStyle: (style: XfadeStyle) => void;
  /** Give every cut this cross-fade (lib/editorFxPack.ts applyCrossfadeToAll). */
  onCrossfadeAll?: () => void;
  crossfadeAllNote?: string | null;
  onSplit: () => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const id = useId();
  return (
    <>
      <h2 className="m-0 text-sm font-semibold">
        {fmt(te.clipHeading, { n })}
      </h2>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={te.trimIn}
          value={clip.in_s}
          min={0}
          max={clip.out_s}
          step={0.1}
          onCommit={onIn}
        />
        <NumberField
          label={te.trimOut}
          value={clip.out_s}
          min={clip.in_s}
          // a frozen clip's end is its hold length, not a place in the file
          max={clip.freeze ? MAX_DURATION_S : (sourceS ?? undefined)}
          step={0.1}
          onCommit={onOut}
        />
      </div>
      {speed}
      <FitPicker fit={fit} still={still} onChange={onFit} />
      <ClipGradePanel
        grade={grade}
        onChange={onGrade}
        onReset={onGradeReset}
      />
      {fx}
      <label className="tap-row flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={clip.audio}
          disabled={audioLocked}
          onChange={(e) => onAudio(e.target.checked)}
          className="size-4 accent-[var(--color-primary)]"
        />
        {te.sound}
      </label>
      {sound}
      <fieldset
        className="m-0 flex flex-col gap-1.5 border-0 p-0"
        aria-describedby={`${id}-xf`}
      >
        <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
          {te.transition}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {(["cut", "crossfade"] as const).map((kind) => {
            const on = kind === "cut" ? crossfade <= 0 : crossfade > 0;
            const disabled = kind === "crossfade" && !maxX && crossfade <= 0;
            return (
              <label
                key={kind}
                className="ns-chip"
                data-radio=""
                data-on={on ? "true" : undefined}
                data-disabled={disabled ? "true" : undefined}
              >
                <input
                  type="radio"
                  name={`${id}-xf`}
                  value={kind}
                  checked={on}
                  disabled={disabled}
                  onChange={() =>
                    onCrossfade(
                      kind === "cut" ? 0 : Math.min(XFADE_DEFAULT_S, maxX),
                    )
                  }
                  className="sr-only"
                />
                {kind === "cut" ? te.cut : te.crossfade}
              </label>
            );
          })}
        </div>
        {crossfade > 0 && maxX ? (
          <NumberField
            label={te.crossfadeLength}
            value={crossfade}
            min={XFADE_MIN_S}
            max={maxX}
            step={0.1}
            onCommit={onCrossfade}
          />
        ) : null}
        {crossfade > 0 && maxX ? (
          <TransitionStylePicker
            value={crossfadeStyle}
            onChange={onCrossfadeStyle}
          />
        ) : null}
        {crossfade > 0 && onCrossfadeAll ? (
          <button
            type="button"
            onClick={onCrossfadeAll}
            data-testid="crossfade-all"
            className="btn-quiet inline-flex min-h-11 items-center self-start px-3 py-1.5 text-xs"
          >
            {t.editor.parity2b.transitionAll.button}
          </button>
        ) : null}
        {crossfadeAllNote ? (
          <p role="status" className="m-0 text-xs" data-testid="crossfade-all-note">
            {crossfadeAllNote}
          </p>
        ) : null}
        <p id={`${id}-xf`} className="m-0 text-xs text-[var(--color-muted)]">
          {first
            ? te.crossfadeFirst
            : !maxX && crossfade <= 0
              ? fmt(te.crossfadeTooShort, { min: XFADE_MIN_S })
              : te.crossfadeHint}
        </p>
      </fieldset>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={onSplit}
          disabled={!canSplitHere}
          aria-describedby={canSplitHere ? undefined : `${id}-split`}
          className={`${quietBtn} self-start`}
        >
          <Scissors className="size-3.5" aria-hidden />
          {te.split}
        </button>
        {!canSplitHere ? (
          <p
            id={`${id}-split`}
            className="m-0 text-xs text-[var(--color-muted)]"
          >
            {clip.speed_curve ? te.fx.speed.splitCurve : te.splitHint}
          </p>
        ) : clip.reverse || clip.freeze ? (
          <p className="m-0 text-xs text-[var(--color-muted)]">
            {clip.reverse ? te.fx.speed.splitReversed : te.fx.speed.splitFrozen}
          </p>
        ) : null}
      </div>
      {copy}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={first}
          className={quietBtn}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {te.moveEarlier}
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={last}
          className={quietBtn}
        >
          <ArrowRight className="size-3.5" aria-hidden />
          {te.moveLater}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={onlyClip}
          className={`${quietBtn} text-[var(--color-fail)]`}
        >
          <Trash2 className="size-3.5" aria-hidden />
          {te.deleteClip}
        </button>
      </div>
      {onlyClip ? (
        <p className="m-0 text-xs text-[var(--color-muted)]">
          {te.lastClip}
        </p>
      ) : null}
    </>
  );
}

function TextInspector({
  text,
  warning,
  onChange,
  onLook,
  anim,
  onDelete,
}: {
  text: TextClip;
  warning: "empty" | "past_end" | null;
  onChange: (patch: Partial<Omit<TextClip, "id">>) => void;
  onLook: (lookId: string) => void;
  /** The entrance / exit section (TextAnimSection). */
  anim?: ReactNode;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const id = useId();
  const [draft, setDraft] = useState(text.text);
  useEffect(() => setDraft(text.text), [text.text]);
  const pos = positionOf(text);
  return (
    <>
      <h2 className="m-0 text-sm font-semibold">{te.textLabel}</h2>
      <div className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
        <label className="flex flex-col gap-1">
          {te.textLabel}
          <textarea
            value={draft}
            maxLength={MAX_TEXT}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== text.text && onChange({ text: draft })}
            aria-describedby={`${id}-count`}
            className="rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]"
          />
        </label>
        <span id={`${id}-count`} className="text-xs">
          {fmt(te.textCount, { n: draft.length, max: MAX_TEXT })}
        </span>
      </div>
      {warning ? (
        <p role="status" className="m-0 text-xs text-[var(--color-warn)]">
          {warning === "empty" ? te.textEmpty : te.textPastEnd}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={te.textStart}
          value={text.start_s}
          min={0}
          step={0.1}
          onCommit={(v) =>
            onChange({ start_s: v, end_s: Math.max(text.end_s, v + 0.1) })
          }
        />
        <NumberField
          label={te.textEnd}
          value={text.end_s}
          min={text.start_s}
          step={0.1}
          onCommit={(v) => onChange({ end_s: v })}
        />
      </div>
      <TextLookPicker text={text} onPick={onLook} />
      <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
        {te.textSize} · {text.size}
        <input
          type="range"
          min={TEXT_SIZE_MIN}
          max={TEXT_SIZE_MAX}
          step={2}
          value={text.size}
          onChange={(e) => onChange({ size: Number(e.target.value) })}
          className="accent-[var(--color-primary)]"
        />
      </label>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
          {te.textPosition}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(TEXT_POSITIONS) as TextPosition[]).map((p) => (
            <label
              key={p}
              className="ns-chip"
              data-radio=""
              data-on={pos === p ? "true" : undefined}
            >
              <input
                type="radio"
                name={`${id}-pos`}
                value={p}
                checked={pos === p}
                onChange={() => onChange({ ...TEXT_POSITIONS[p] })}
                className="sr-only"
              />
              {te.positions[p]}
            </label>
          ))}
        </div>
      </fieldset>
      {anim}
      <button
        type="button"
        onClick={onDelete}
        className={`${quietBtn} self-start text-[var(--color-fail)]`}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {te.deleteText}
      </button>
    </>
  );
}

function SoundInspector({
  sound,
  name,
  sourceS,
  warning,
  hasSpeech,
  onChange,
  onToPlayhead,
  onFit,
  clean,
  onDelete,
}: {
  sound: SoundClip;
  name: string;
  sourceS: number | null;
  warning: "past_end" | null;
  /** Whether anything on the timeline is speech (what a duck lowers under). */
  hasSpeech: boolean;
  onChange: (patch: Partial<Omit<SoundClip, "id" | "asset_id">>) => void;
  onToPlayhead: () => void;
  onFit: () => void;
  /** The clean-up section (SoundCleanSection). */
  clean?: ReactNode;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const id = useId();
  const len = soundLength(sound);
  const fadeMax = Math.min(SOUND_FADE_MAX_S, len);
  return (
    <>
      <h2 className="m-0 text-sm font-semibold">{te.soundHeading}</h2>
      <p className="m-0 truncate text-xs text-[var(--color-muted)]">
        {name} · <Timecode value={len} format="duration" label={formatTime(len)} />
      </p>
      {warning ? (
        <div role="status" className="flex flex-col gap-1.5">
          <p className="m-0 text-xs text-[var(--color-warn)]">
            {te.soundPastEnd}
          </p>
          <button
            type="button"
            onClick={onFit}
            className={`${quietBtn} self-start`}
          >
            {te.soundFit}
          </button>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={te.soundStart}
          value={sound.start_s}
          min={0}
          step={0.1}
          onCommit={(v) => onChange({ start_s: v })}
        />
        <div className="flex items-end">
          <button
            type="button"
            onClick={onToPlayhead}
            className={`${quietBtn} w-full justify-center`}
          >
            {te.soundToPlayhead}
          </button>
        </div>
        <NumberField
          label={te.soundIn}
          value={sound.in_s}
          min={0}
          max={sound.out_s}
          step={0.1}
          onCommit={(v) => onChange({ in_s: v })}
        />
        <NumberField
          label={te.soundOut}
          value={sound.out_s}
          min={sound.in_s}
          max={sourceS ?? undefined}
          step={0.1}
          onCommit={(v) => onChange({ out_s: v })}
        />
      </div>
      <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
        <span id={`${id}-vol`}>
          {te.soundVolume} · {fmt(te.soundVolumeValue, { db: sound.gain_db })}
        </span>
        <input
          type="range"
          min={Math.min(GAIN_UI_MIN, sound.gain_db)}
          max={Math.max(GAIN_UI_MAX, sound.gain_db)}
          step={1}
          value={sound.gain_db}
          aria-valuetext={fmt(te.soundVolumeValue, { db: sound.gain_db })}
          onChange={(e) =>
            onChange({
              gain_db: Math.min(
                GAIN_DB_MAX,
                Math.max(GAIN_DB_MIN, Number(e.target.value)),
              ),
            })
          }
          className="accent-[var(--color-primary)]"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={te.soundFadeIn}
          value={sound.fade_in_s}
          min={0}
          max={fadeMax}
          step={0.1}
          onCommit={(v) => onChange({ fade_in_s: v })}
        />
        <NumberField
          label={te.soundFadeOut}
          value={sound.fade_out_s}
          min={0}
          max={fadeMax}
          step={0.1}
          onCommit={(v) => onChange({ fade_out_s: v })}
        />
      </div>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
          {te.soundKind}
        </legend>
        <div className="flex gap-1.5">
          {(["music", "speech"] as const).map((r) => {
            const on = (sound.role ?? "music") === r;
            return (
              <Chip
                key={r}
                pressed={on}
                onClick={() => {
                  if (!on) onChange({ role: r });
                }}
              >
                {r === "music" ? te.roleMusic : te.roleSpeech}
              </Chip>
            );
          })}
        </div>
        <p className="m-0 text-xs text-[var(--color-muted)]">
          {sound.role === "speech" ? te.roleSpeechHint : te.roleMusicHint}
        </p>
      </fieldset>
      {sound.role !== "speech" ? (
        <div className="flex flex-col gap-2">
          <label className="tap-row flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={Boolean(sound.duck)}
              onChange={(e) =>
                onChange({ duck: e.target.checked ? DUCK_DEFAULT : undefined })
              }
              className="accent-[var(--color-primary)]"
            />
            {te.duckToggle}
          </label>
          {sound.duck ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
                <span>
                  {te.duckAmount} ·{" "}
                  {fmt(te.soundVolumeValue, { db: -sound.duck.amount_db })}
                </span>
                <input
                  type="range"
                  min={Math.min(DUCK_UI_MIN_DB, sound.duck.amount_db)}
                  max={Math.max(DUCK_UI_MAX_DB, sound.duck.amount_db)}
                  step={1}
                  value={sound.duck.amount_db}
                  aria-valuetext={fmt(te.soundVolumeValue, {
                    db: -sound.duck.amount_db,
                  })}
                  onChange={(e) =>
                    onChange({
                      duck: {
                        ...(sound.duck ?? DUCK_DEFAULT),
                        amount_db: Math.min(
                          DUCK_DB_MAX,
                          Number(e.target.value),
                        ),
                      },
                    })
                  }
                  className="accent-[var(--color-primary)]"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label={te.duckAttack}
                  value={sound.duck.attack_s}
                  min={DUCK_ATTACK_MIN_S}
                  max={DUCK_ATTACK_MAX_S}
                  step={0.05}
                  onCommit={(v) =>
                    onChange({
                      duck: {
                        ...(sound.duck ?? DUCK_DEFAULT),
                        attack_s: v,
                      },
                    })
                  }
                />
                <NumberField
                  label={te.duckRelease}
                  value={sound.duck.release_s}
                  min={DUCK_RELEASE_MIN_S}
                  max={DUCK_RELEASE_MAX_S}
                  step={0.1}
                  onCommit={(v) =>
                    onChange({
                      duck: {
                        ...(sound.duck ?? DUCK_DEFAULT),
                        release_s: v,
                      },
                    })
                  }
                />
              </div>
              <p
                role={hasSpeech ? undefined : "status"}
                className={`m-0 text-xs ${hasSpeech ? "text-[var(--color-muted)]" : "text-[var(--color-warn)]"}`}
              >
                {hasSpeech ? te.duckHint : te.duckNoSpeech}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      {clean}
      <button
        type="button"
        onClick={onDelete}
        className={`${quietBtn} self-start text-[var(--color-fail)]`}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {te.deleteSound}
      </button>
    </>
  );
}
