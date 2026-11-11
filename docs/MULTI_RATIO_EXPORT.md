# One edit, several frame sizes (multi-ratio export)

Behind `NIGHTSHIFT_MULTI_RATIO_EXPORT`, **default off**. Migration `0129_editor_export_frame.sql`.

One saved edit can be exported in more than one frame size (16:9, 9:16, 1:1, 4:5) without a copy of the project per size. Until
now an export always rendered the saved revision in the project's own frame, one export per project at a time.

## What a person sees (switch on, 0129 applied)

Under the Export button, beside "Export format", a second disclosure: **Sizes to export**. It is a group of checkboxes: "This
project's size" (ticked) and every other export format (`schemas/export_presets.json`). Pressing Export asks for **one export per
ticked size**. Each is a separate video in the library, each has its own status panel, and each counts toward the limits.

It is not an edit: nothing in the document changes, nothing is saved, the project keeps its size.

## The rules

| Rule | Where |
| :-- | :-- |
| A size is named by the **id of a format on the closed list** and by nothing else. No width, height or ratio is accepted from a client. | route `parseExportFrames`, database `editor_export_frame()`, worker `frame_override()` |
| The database reads width and height from **its own copy of the list** and stores them on the export row. | 0129 |
| The worker renders a frame only if the row's three values are **exactly one entry** of `schemas/export_presets.json`; otherwise the export fails with `invalid_frame` and nothing is read or rendered. A row with only some of the three values is refused the same way. | `modules/editor_export.py` |
| **Each size is one export.** It takes one of the organization's three waiting-or-rendering places and one of its twenty a day, and it is free. One request names at most three sizes. | 0054 limits, unchanged; `MAX_EXPORT_FRAMES` |
| One export at a time per project **per size** (new overload only). The same size of the same project twice is `export_in_progress`, and a format that is the project's own size counts as the project's own frame: it is refused while the plain export is in flight. The route refuses a request naming both. | 0129, the one line of 0054 with a new shape |
| Only the picture's **width and height** change. The frame rate, clips, texts and every clip's own `fit` stay as saved. | `framed_doc` |
| A clip whose shape is not the new frame's is fitted the way **that clip already says**: `contain` (bars) unless the person chose `cover` or `blur`. Never a crop nobody asked for. | `modules/timeline.py` `fit`, unchanged |
| The document is validated against the **new** frame (the budgets for backwards play, smoothing, steadying and blur depend on the frame's size). An edit that does not fit ends as `invalid_timeline`; the picker checks first and disables that size with a sentence. | `timeline.load`, `frameProblems` |
| An export in another size is a **new library file** with its own id and sha256. It carries no approval and reaches no publish path. | nothing here touches the publish gate |

Text sizes are in output pixels, so the same text is larger relative to a narrower frame, exactly as when the format is changed in
"Export format". Look at a size there first when the layout matters.

## The switch

`NIGHTSHIFT_MULTI_RATIO_EXPORT` is one GitHub repository variable that feeds **both** halves:

* **Command Center** (`lib/multiRatioExport/flag.ts`): off = no picker, and `POST /api/editor/projects/<id>/exports` does not read the
  request's `frames` field at all.
* **Media worker** (`modules/editor_export.py` `FRAME_FLAG`): off = an export row that carries a frame is failed at once with
  `frame_off`, before any file is read. An export without a frame is rendered as always.

The database function is callable by a signed-in member whatever the switch says (it is granted like the two-argument one). That is
safe by itself (closed list, same limits, same organization checks), and with the worker's half off such a row is never rendered.

## Roll-out order

Does not matter:

* **Web before 0129.** The editor reads the frame columns only while the switch is on; a database without them answers "no such
  column", the read falls back to the old columns and the picker stays hidden: the plain export only. If a request with `frames`
  still arrives, the three-argument call gets `PGRST202` and that size is answered `not_available`. Nothing is rendered in its
  place: an export in the wrong size would be a quiet substitute. The project's own size still goes through.
* **0129 before web.** Nothing calls the new overload.
* **Worker older than this change.** It ignores the new columns and would render the project's frame. Turn the switch on only when
  the web and the worker both run this version. If it happens anyway, the editor says so: a finished export whose file is not the
  size that was asked for shows a warning with both sizes.

## Undo

Turn the switch off (picker gone, worker refuses frame rows). To take the migration out:
`docs/sql/rollback_0129_editor_export_frame.sql` (owner-applied). It refuses while an export in flight carries a frame. Videos
already exported stay in the library.
