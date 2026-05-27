# Capture block — recaptcha 3×3 tile picker

When you hit a Google reCAPTCHA image challenge ("Select all squares with
motorcycles", "Select all images with traffic lights"), emit a fenced
` ```capture ` block with a single screenshot of the 3×3 tile grid. The
renderer slices that one image into 9 clickable tiles on the user's
screen. After the user picks tiles and confirms, you receive a new user
message listing the selected tile indices.

## When to use it

- Google reCAPTCHA v2 image challenges (3×3 grid, sometimes 4×4).
- Any captcha that asks "click all tiles containing X".

Do NOT use it for:

- Text or audio captchas.
- hCaptcha / Cloudflare Turnstile / Funcaptcha.
- Drag-puzzle or rotation captchas.
- General "look at this image" questions (use an inline image instead).

## The flow

1. Find the captcha iframe. Record its **page-coordinate bounding box**
   for the **grid area only** (the 3×3 image grid). Exclude the prompt
   header and the Verify/Audio/Reload toolbar — the renderer slices the
   image into equal tiles, so any non-tile pixels in the screenshot
   throw off the tile boundaries the user sees.
2. Call `Page.captureScreenshot` with a `clip` rect equal to that
   bounding box. The wrapper auto-saves the PNG into the session's
   outputs dir and returns the path.
3. Emit:
   ```
   ```capture
   {
     "prompt": "Select all images with motorcycles",
     "image": "/abs/path/to/recaptcha-grid.png",
     "rows": 3,
     "cols": 3
   }
   ```
   ```
4. **Stop calling tools.** Your turn ends. The browser session stays
   warm. When the user clicks tiles and confirms, you receive a reply:
   > Captcha selected tiles: 0, 2, 6

   Indices are 0-based, left-to-right, top-to-bottom:
   ```
   0 1 2
   3 4 5
   6 7 8
   ```
5. Convert each index back to its tile center using the grid bounding
   box you saved in step 1:
   ```js
   const tileW = grid.w / cols  // cols = 3
   const tileH = grid.h / rows  // rows = 3
   for (const i of indices) {
     const row = Math.floor(i / cols)
     const col = i % cols
     const cx = grid.x + (col + 0.5) * tileW
     const cy = grid.y + (row + 0.5) * tileH
     await session.Input.dispatchMouseEvent({ type: 'mousePressed',  x: cx, y: cy, button: 'left', clickCount: 1 })
     await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
   }
   ```
6. Press Verify, wait for the page to settle, and continue.

## Fields

| field    | required | notes |
|----------|----------|-------|
| `image`  | **yes**  | Absolute path to the screenshot file (under the outputs dir). |
| `prompt` | no       | The captcha's instruction text ("Select all motorcycles"). |
| `rows`   | no       | Default `3`. Set to `4` for the rare 4×4 challenge. |
| `cols`   | no       | Default `3`. |

## The turn-ending rule

After the closing ` ``` `, **stop**. No more tool calls. Wait for the
user's reply.

## "(none)" replies

If the user confirms without picking any tile, you get:

> Captcha selected tiles: (none)

This usually means the prompt has no matches in the visible grid.
reCAPTCHA's UI expects a "Skip" / fresh challenge in that case — press
Verify anyway; the challenge will either accept (rare) or refresh to a
new image set.

## Banned

- Cropping to anything beyond the 3×3 grid (prompt header, Verify
  button). The renderer assumes the image is the grid only.
- Multiple `capture` fences in one turn. One challenge at a time.
- Inline base64 in `image` — the renderer expects an absolute path; the
  `Page.captureScreenshot` wrapper already saves to a real file.
