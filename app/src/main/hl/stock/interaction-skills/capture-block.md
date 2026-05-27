# Capture block — reCAPTCHA 3×3 tile picker

When you hit a Google reCAPTCHA image challenge ("Select all squares with
motorcycles", "Select all images with traffic lights"), emit a fenced
` ```capture ` block. The renderer slices your single screenshot into 9
clickable tiles + a reCAPTCHA-style header bar; the user picks tiles and
their selection comes back to you as a new user turn.

## Hard constraints — read first

1. **Only the 3×3 grid.** No prompt header, no Verify/Audio/Info row, no
   surrounding chrome. The renderer evenly subdivides whatever PNG you
   send into 9 tiles; any extra pixels break the tile boundaries.
2. **CSS pixels everywhere.** `Page.captureScreenshot`'s `clip` uses CSS
   pixels regardless of devicePixelRatio. NEVER reason about the output
   PNG's pixel dimensions when picking clip coordinates. Don't run `sips
   --cropOffset` on the saved PNG — that's output-pixel space and you'll
   double-scale.
3. **No tool calls after the closing fence.** Your turn ends; the agent
   process idles until the user submits.

## The reliable recipe — copy this

reCAPTCHA's bframe iframe is same-origin with the parent (`google.com`
→ `google.com`), so you can reach into its DOM directly via the parent
page. Compute the grid rect from the **individual tile cells** —
*never* from the `<table>` element itself, because that element's
bounding rect includes extra layout space (the floating toolbar
sometimes sits absolutely positioned inside it, and certain
challenge variants pad the table beyond the visible tile area).

```js
browser-harness-js <<'EOF'
const fs = await import('fs')

const r = await session.Runtime.evaluate({
  expression: `JSON.stringify((() => {
    // Locate the bframe and reach into its DOM (same origin).
    const bf = Array.from(document.querySelectorAll('iframe'))
      .find(el => el.src.includes('/recaptcha/api2/bframe'));
    if (!bf) return { error: 'bframe not found' };
    const ifRect = bf.getBoundingClientRect();
    const doc = bf.contentDocument;
    if (!doc) return { error: 'bframe content not accessible' };

    // The actual visible tile cells. Their union is the true 3×3 rect.
    // Do NOT use .rc-imageselect-table-33 — it can be taller than its
    // visible cells.
    const tiles = Array.from(doc.querySelectorAll('td.rc-imageselect-tile'));
    if (tiles.length === 0) return { error: 'no tile cells (is challenge open?)' };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tiles) {
      const r = t.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x + r.width > maxX) maxX = r.x + r.width;
      if (r.y + r.height > maxY) maxY = r.y + r.height;
    }

    // Derive grid shape from the tile count, not the table class name.
    const cols = Math.round(Math.sqrt(tiles.length)) === 4 ? 4 : 3;
    const rows = cols;

    // Read the prompt + target text while we're inside the bframe.
    const desc = doc.querySelector('.rc-imageselect-desc-no-canonical, .rc-imageselect-desc');
    const promptText = desc?.textContent?.trim() ?? '';
    const target = desc?.querySelector('strong')?.textContent?.trim() ?? '';
    const candidateImg = doc.querySelector('.rc-imageselect-candidates img, .rc-canonical-bounding-box img');
    const targetImage = candidateImg?.src ?? null;

    // Tile-union → parent-page coordinates.
    return {
      grid: { x: ifRect.x + minX, y: ifRect.y + minY, w: maxX - minX, h: maxY - minY },
      rows, cols, promptText, target, targetImage,
    };
  })())`,
  returnByValue: true,
})
const info = JSON.parse(r.result.value)
if (info.error) throw new Error(info.error)
const { grid, rows, cols, promptText, target, targetImage } = info

// Clip-screenshot to the tile union, in CSS pixels.
const shot = await session.Page.captureScreenshot({
  format: 'png',
  clip: { x: grid.x, y: grid.y, width: grid.w, height: grid.h, scale: 1 },
})
const path = `${process.env.BU_OUTPUTS_DIR}/recaptcha-grid.png`
fs.writeFileSync(path, Buffer.from(shot.data, 'base64'))

// Stash the grid rect for the click-back step on the next turn.
globalThis.__captcha_grid = { ...grid, rows, cols }
return { path, grid, rows, cols, promptText, target, targetImage }
EOF
```

### Verification — required before emitting the fence

Read the saved PNG back as an image and confirm:

1. **It's a near-square** — width/height ratio between 0.95 and 1.05.
2. **No toolbar visible** at the bottom (no refresh/audio/info icons,
   no Verify/Skip button). If you see them, the tile union query was
   bypassed somewhere — re-run the recipe; do not crop the saved PNG
   with `sips` or `magick`.
3. **9 cells fill the frame edge-to-edge.** You should see grout lines
   roughly at 33% and 66% horizontally and vertically. If there's
   blank space on any edge, the bframe rect was stale — wait 500ms and
   re-query.

If anything fails, click the checkbox again to refresh the challenge
and re-run the recipe. Don't ship a wrong screenshot — the user will
see misaligned tiles and click the wrong cells.

### Common failures and how to avoid them

- **Querying `.rc-imageselect-table-33` for height.** Its
  `getBoundingClientRect` can be 388×388 even when the visible tiles
  occupy only the top ~290px; the bottom strip contains the floating
  Verify toolbar. Always use the per-tile union recipe above.
- **Mixing CSS and output-pixel space.** `Page.captureScreenshot`'s
  `clip` is in CSS pixels; the saved PNG comes out at CSS×DPR. NEVER
  run `sips --cropOffset` on the saved PNG — that's output-pixel
  space and you'll double-scale. If you need to re-crop, do it via
  another `captureScreenshot` call with a tighter clip.
- **Reading the bframe rect too early.** Right after clicking the "I'm
  not a robot" checkbox the bframe is repositioning. Wait 500ms
  before measuring.

## Reading the challenge text

The prompt ("Select all images with cars") and the example thumbnail
live inside the bframe — cross-origin, so you can't query them from
the parent. Attach to the bframe via CDP:

```js
browser-harness-js <<'EOF'
const targets = (await session.Target.getTargets()).targetInfos
const bf = targets.find(t => t.type === 'iframe' && t.url.includes('/bframe'))
const { sessionId } = await session.Target.attachToTarget({ targetId: bf.targetId, flatten: true })

const r = await cdp('Runtime.evaluate', {
  expression: `JSON.stringify((() => {
    // The challenge header. ".rc-imageselect-desc-no-canonical" covers
    // most prompts; ".rc-imageselect-desc" is the fallback shape.
    const desc = document.querySelector('.rc-imageselect-desc-no-canonical, .rc-imageselect-desc')
    const text = desc?.textContent?.trim() ?? ''
    // Bold target ("cars") is in the inner <strong>.
    const target = desc?.querySelector('strong')?.textContent?.trim() ?? ''
    // Optional example thumbnail (some 4x4 challenges show one top-right).
    const img = document.querySelector('.rc-imageselect-candidates img, .rc-imageselect-tileselected')
    const targetImage = img?.src ?? null
    return { text, target, targetImage }
  })())`,
  returnByValue: true,
}, sessionId)
return JSON.parse(r.result.value)
EOF
```

Use `text` (everything before the bold word, e.g. "Select all images
with") as `prompt`, the bold subject as `target`, and the thumbnail
URL as `targetImage` (optional).

## Emit the fence

```
```capture
{
  "prompt": "Select all images with",
  "target": "cars",
  "targetImage": "https://www.gstatic.com/recaptcha/api2/payload?...",
  "image": "/abs/path/outputs/<session>/recaptcha-grid.png",
  "rows": 3,
  "cols": 3
}
```
```

Then **stop**. No more tool calls. Wait for the user reply:

> Captcha selected tiles: 0, 2, 6

Indices are 0-based, left-to-right, top-to-bottom:

```
0 1 2
3 4 5
6 7 8
```

## Clicking the selected tiles

When the reply arrives, convert each index to a click on the live
page using the grid rect you stashed:

```js
browser-harness-js <<'EOF'
const grid = globalThis.__captcha_grid
const indices = [0, 2, 6] // from the user reply

const COLS = 3, ROWS = 3
const tileW = grid.w / COLS
const tileH = grid.h / ROWS

for (const i of indices) {
  const row = Math.floor(i / COLS)
  const col = i % COLS
  const cx = grid.x + (col + 0.5) * tileW
  const cy = grid.y + (row + 0.5) * tileH
  await session.Input.dispatchMouseEvent({ type: 'mousePressed',  x: cx, y: cy, button: 'left', clickCount: 1 })
  await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 120))
}
// Verify button is roughly at (grid.x + 250, grid.y + 380); compute via
// the bframe rect rather than hardcoding once you've handled the picks.
return 'clicked'
EOF
```

## Fields

| field         | required | notes |
|---------------|----------|-------|
| `image`       | **yes**  | Absolute path under the outputs dir. Only the 3×3 grid, edge-to-edge. |
| `prompt`      | recommended | Lead-in text ("Select all images with"). Without it the picker still works but has no header context. |
| `target`      | recommended | The bold subject ("cars", "motorcycles"). Rendered in the reCAPTCHA-style blue header. |
| `targetImage` | optional | URL of the example thumbnail (some challenges show one). Renders on the right side of the header. |
| `rows`        | optional | Default `3`. Set to `4` for the rare 4×4 challenge. |
| `cols`        | optional | Default `3`. |

## When the bframe layout is non-standard

The constants above (32 / 120 / 336) cover the dark-themed, standard-
sized challenge that ~99% of reCAPTCHA v2 traffic shows. If a
screenshot using these comes back wrong (off-center, includes the
prompt bar, or doesn't fill 9 tiles), attach to the bframe and read
the grid's bounding rect directly:

```js
// inside the bframe CDP session you attached above
const r = await cdp('Runtime.evaluate', {
  expression: `JSON.stringify((() => {
    const g = document.querySelector('.rc-imageselect-table-33, .rc-imageselect-table-44')
    if (!g) return null
    const r = g.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })())`,
  returnByValue: true,
}, bframeSessionId)
const inner = JSON.parse(r.result.value)
// Add bframe outer offset to convert inner-iframe coords → page coords.
const grid = { x: bf.x + inner.x, y: bf.y + inner.y, w: inner.w, h: inner.h }
```

## "(none)" replies

If the user confirms without picking any tile, you get:

> Captcha selected tiles: (none)

Click Verify anyway — reCAPTCHA will either accept (rare) or refresh
to a new challenge. Don't loop emitting fresh `capture` blocks without
giving the user a chance to actually solve the new one.

## Banned

- Cropping to anything beyond the 3×3 grid. The renderer subdivides
  the image evenly into 9 tiles — extra pixels = misaligned tiles.
- Running `sips` / `magick` to crop the saved PNG. Always use the
  `clip` parameter of `Page.captureScreenshot` so you stay in CSS
  pixels.
- Multiple `capture` fences in one turn. One challenge at a time.
- Inline base64 in `image`. The renderer expects an absolute file path;
  `Page.captureScreenshot`'s wrapper already saves to a real file.
- Eyeballing offsets. Use the constants in the recipe above. If they
  fail, fall back to the bframe CDP attach pattern — never guess.
