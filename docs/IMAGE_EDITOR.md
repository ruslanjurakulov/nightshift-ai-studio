# Image editor (dark, `NIGHTSHIFT_IMAGE_EDITOR`, default off)

Crop, turn, flip, colours, text and shapes on one library picture, in the browser. Saving flattens the result with a canvas
and uploads it as a NEW library file through the upload path that already exists. Nothing here is switched on: the page is a
404 (answered before the page reads any picture or organization; the shared `(app)` layout still checks the session first, as for every page) until the owner sets `NIGHTSHIFT_IMAGE_EDITOR=on` on the Command Center's server (`deploy/.env.web.example`, repository
variable `NIGHTSHIFT_IMAGE_EDITOR`, mapped as `WEBENV_NIGHTSHIFT_IMAGE_EDITOR` in `deploy_web.yml`). It is a web-only switch:
no worker reads it, because no worker runs an image edit.

## What is built

| Piece | Where |
| :-- | :-- |
| Page `/{channel}/editor/image/{assetId}` (flag, uuid check, ownership check, then the editor) | `app/(app)/[channel]/editor/image/[assetId]/page.tsx` |
| Ownership and size read (RLS client, organization must match, image, JPEG/PNG/WebP, size recorded, at most 16 MP) | `lib/server/image-editor.ts` |
| Pure logic: state, turn/flip/crop maths, layers, colour pass, undo stack, save name and upload | `lib/imageEditor/*` |
| Konva canvas, the shared scene builder and the flattening export, the picture pass | `components/imageEditor/EditorCanvas.tsx`, `scene.ts`, `render.ts` |
| Panels and the editor | `components/imageEditor/panels.tsx`, `NumField.tsx`, `ImageEditor.tsx` |
| Strings (`imageEditor.*`) | `lib/i18n/image-editor/{en,ru,uz}.ts` |

There is no API route, no migration, no worker and no new dependency (Konva was already there for the region editor).

## How the pieces fit

* The state is one small immutable value: mirror + quarter turns, a crop window, three colour numbers, up to 20 layers. Undo and
  redo snapshot it; one slider drag is one undo step.
* Order of operations when saving, and in the preview: mirror and turn the source, cut the crop window, colour it (brightness,
  then contrast, then saturation: `lib/imageEditor/adjust.ts`, the SAME function for the preview and the file), draw the layers over it.
  Colours therefore never touch the text and shapes. Layers are anchored by their centre in canvas space so a turn or a flip keeps them on
  the same spot of the picture without measuring text.
* The saved file is exactly the crop's size (or the whole turned canvas) at pixel ratio 1.
* Text is plain characters in one of three generic font families (`sans`, `serif`, `mono`); colours are `#rrggbb`; shapes are rectangle,
  ellipse and one straight line. No SVG is read or written, no font is loaded, no user markup reaches a canvas.

## Saving

`POST /api/media/uploads` (ticket: membership, type allowlist, size cap, quota), then `PUT /api/media/uploads/<ticket>` with the PNG (or
JPEG) bytes. The media worker re-checks, re-encodes and strips it like any other upload, so the browser's output is treated as untrusted
input. The original is never touched.

* The ticket route has no parent argument (`request_upload` takes none; `parent_asset_id` is written only by the worker), so the new file is
  linked to the original by NAME only (`<name>-edited.png`). A real `parent_asset_id` link would need a new argument on `request_upload`
  and the ingest registration: a migration, not done here.
* A picture of more than 16 megapixels is refused (`MAX_EDIT_PIXELS`), by the page from the library's recorded size, by the editor again
  from the size the browser really decoded. 16 MP is also what browsers can hold in a single canvas (iOS Safari: 16,777,216 pixels).
* The new file lands in **All files** (no folder): the ticket is asked for without a `folder_id`, wherever the original lives.
* After a save the Save key stays off while the picture is exactly the saved one (also after an undo back to it), so a second press cannot
  upload a duplicate; any further change turns it on again and makes another new file.
* A JPEG has no transparency, so it is saved on white and the preview shows white too while JPEG is chosen. A PNG keeps transparency.
* The file name is cleaned by `cleanUploadName` (control characters dropped; bidi override characters such as U+202E are NOT stripped, as for any upload).
* HEIC, GIF, SVG, video and audio are not opened (`unsupported`): a canvas flatten of an animation or a vector would silently lose it.

## AI operations

The "AI tools" tab has five links into Studio (`/create?tool=upscale|remove_bg|expand|relight|erase&source=<id>`), the same links the
Library viewer uses. They carry the ORIGINAL picture's id, never an edit and never the new file (the new file has no id until the media
worker has checked it), and the screen says so: to use your edits, save, wait for the file to appear, and choose it in Studio's picture
chooser. Studio shows the price and holds the credits as for any job; this page adds no pricing path and calls none.

## Unsaved edits

While the picture has edits that are not saved: the browser asks on a tab close or reload (`beforeunload`), and a click on an in-app link (the
Library link, the main navigation) asks with a confirm (`lib/imageEditor/leave.ts`, a capture-phase listener that runs before Next's Link). The
browser's **Back button is not covered**: the App Router offers no way to cancel it. A new tab (Ctrl/Cmd+click), a download and a same-page anchor
never ask.

## Doubts

* Konva on touch has not been tried on a real phone; the canvas takes `touch-action: none` only while cropping or a layer is selected.
* Text drawn in a preview at a reduced scale and in the file at full scale can differ by a pixel or two of line breaking, because font
  metrics are not perfectly linear. Layers are centre-anchored, so the difference is symmetric.
* PNG of a 16 MP photograph can exceed the upload cap; the person then gets the cap in the sentence and the JPEG choice.
* The entry point (an "Edit" button in the Library viewer) is NOT added: it would need the server flag passed down to a client
  component. Until then the page is reached by its address.
* ru and uz wording is the author's and needs a native read.
