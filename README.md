# Braille Art Generator

[Русский](README.ru.md) · **English**

Turns an image into text made of **Unicode braille** glyphs (U+2800…U+28FF).
Each glyph encodes a 2×4 block of pixels, so it carries four times the detail of
ordinary ASCII art.

It runs entirely in the browser: the image is never uploaded, and the server
only ever hands out static files.

**[Open the generator →](https://jareltis.github.io/Braille_Art_Generator/)**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Older versions: MIT](https://img.shields.io/badge/%E2%89%A4v0.0.12-MIT-green.svg)](LICENSE-MIT)

![The generator: original, adjusted image, sampled pixels and the finished art, all on one screen](docs/screenshot.png)

---

## What it does

| | |
|---|---|
| **Dithering** | Floyd–Steinberg, Atkinson, blue noise, Bayer 4×4 |
| **Thresholds** | global, automatic by Otsu, and local adaptive (Sauvola) |
| **Edge detection** | XDoG for drawn strokes, Sobel for gradients, a slider between fill and lines |
| **Colour** | one tint per cell: on screen, in PNG, SVG, HTML and ANSI for the terminal |
| **Image adjustment** | brightness, contrast, saturation, sharpness |
| **Output** | width and height in cells, proportions kept automatically, inversion |
| **Presets** | photographs, line art, logos, pixel art — each sets every control it covers |
| **Targets** | message limit in view, copying inside a code fence, width measured against your own client |
| **Fitting** | trim blank margins, find the widest size that fits, split into several messages |
| **Source** | a file, lettering in large braille type, the camera, or a drawing |
| **Loading** | file picker, drag and drop, paste with Ctrl+V |
| **Cropping** | drag a rectangle over the preview: empty space selects, inside moves, a corner resizes |
| **Editing** | set and clear individual dots on the finished art, with undo |
| **Two modes** | simple keeps five controls; advanced reveals everything |
| **One screen** | original, adjusted image, sampled pixels and the art are all visible at once |
| **Layouts** | 2×2 by default, strip on top, art-first, single row |
| **Keyboard** | cropping, dot editing and drawing all work without a pointer |
| **Languages** | English and Russian, chosen from the browser and remembered |
| **Offline** | installs as an app and works with no network |
| **No backend** | not one network request after the page has loaded |

An empty cell is emitted as `U+2800 BRAILLE PATTERN BLANK`, not as a space, so
the art keeps its alignment in chats that collapse whitespace.

---

## Run it

The easiest way is to [open the hosted version](https://jareltis.github.io/Braille_Art_Generator/).

Locally, any static server will do — the project is built from ES modules, and
browsers refuse to load those over `file://`, so double-clicking `index.html`
will not work.

```bash
git clone https://github.com/Jareltis/Braille_Art_Generator.git
cd Braille_Art_Generator
```

Then whichever is at hand:

```bash
python -m http.server 8000        # Python 3
npx serve .                       # Node
php -S localhost:8000             # PHP
```

Open `http://localhost:8000`.

There is no build: no `npm install`, no bundler, no dependencies. Publishing is
a matter of copying the folder to GitHub Pages or any static host.

---

## How it works

### The methods

A threshold decides each pixel on its own, so a flat 25% grey has exactly one
answer available to it: nothing. Dithering trades per-pixel accuracy for a
correct local average, which is what makes photographs legible on a grid this
coarse.

- **Floyd–Steinberg** spreads the error over four neighbours. Soft half-tones;
  the right choice for photographs.
- **Atkinson** passes on only six eighths of the error. Losing the rest is the
  point: highlights and shadows clip rather than smear, which reads better on a
  coarse grid.
- **Blue noise** is ordered like Bayer — nothing travels between pixels, so the
  result never shifts when the image is re-cropped — but its tile is built by
  void-and-cluster, spreading thresholds so that no scale carries a repeating
  structure. Error-diffusion texture with position independence.
- **Bayer 4×4** is the classic ordered matrix, with the crosshatch that comes
  with it.
- **Local threshold (Sauvola)** picks a threshold per neighbourhood instead of
  one for the frame. A single number cannot serve a photograph lit from one
  side: whatever it is, one end of the frame is crushed.
- **Plain threshold** for logos, text and line art, where dithering only adds
  noise.

### Two colour spaces, on purpose

Dot coverage is linear in light: half the dots lit emits half the light, so the
fraction that reproduces a tone is that tone's **linear** luminance. Diffusing
error over gamma-encoded values — which most converters of this kind do, and
which this one did until 0.9 — preserves the average of the wrong quantity and
comes out systematically too light. Flat sRGB mid-grey was dithered at 0.50
coverage where it should be 0.22.

Edges want the opposite. A difference of Gaussians answers to curvature, and the
linear luminance of a smooth visual ramp is strongly convex: across five equal
sRGB steps its gaps differ by a factor of 9.2, where the gaps in perceptual
lightness L\* differ by 1.2. Run in linear light, XDoG reports an edge across an
entire gradient.

So the plane the encoder thresholds is linear for tone and perceptual for line,
and `tonePlane()` decides which and says so. The threshold control stays in
sRGB, so its middle is still the middle of what you see, and crosses over once.

### Edges

By default a dot means "bright here". For drawings, anime frames, diagrams and
meme templates that is the wrong question — what matters is the line.

- **XDoG** is the one that draws. The difference only goes negative on the dark
  side of an edge, so the result is a one-sided stroke of varying weight rather
  than a band straddling the boundary, and that variation is the part a 2×4 cell
  can show.
- **Sobel** reports gradient magnitude: fast and predictable, but a soft edge
  comes back as a wide band.

τ is deliberately 1 rather than the ≈0.98 the XDoG paper uses for stylisation.
Below 1 the flat-field response is `l·(1−τ)` — proportional to brightness — so
an even mid-grey answers with ink and dark areas silt up with strokes that are
not edges.

### Colour

A braille cell is a single glyph and can carry one colour however many of its
eight dots are raised. Colour therefore takes no part in deciding the dots — that
stays a question about luminance — it only tints what was already decided.

It is averaged over the pixels whose dots are raised, because only those are
drawn, and the mean is taken in linear light for the same reason dithering is:
half white and half black is sRGB 188, not 128.

Colours live in an array beside the text rather than inside it, so the art stays
a plain string that can be copied, saved and hand-edited. Everything
colour-aware paints runs of near-enough equal colour rather than cells: a
400×400 grid is 160,000 cells, and on the sample image 1155 of them collapse
into 115 spans.

### Why no platform widths are baked in

Generators like to state that Discord is "about 30 characters" and Twitch "about
20". Those numbers look authoritative and are worth nothing: the width moves
with the device, the window, the zoom, the client's own font size setting and
whether the art sits in a code block.

So the code holds only what is checkable — the message length limit. The width
is measured once, by you: **Measure your own chat** hands you a ruler, you paste
it into the client and count the marks before it wraps. The ruler is made of
braille on purpose — a digit is a different width in the same font, so a numeric
ruler would answer a different question.

Beside it is a **vertical scale**, for when the art arrives stretched or
squashed: clients set their own line height, and width alone does not fix that.
Measurements are remembered per target.

### Fitting into a message

Knowing the art is over the limit is not much use on its own.

**Trimming** removes rows and columns of empty cells from the edges. A blank
cell costs a character like any other, and the limit is counted in characters,
so this is the cheapest way to fit and it deletes nothing anyone can see. It is
off by default, because with it on the width field would no longer describe the
output.

**Fitting to the limit** searches for the widest sampling that still passes, by
bisection rather than stepping down: a probe costs a full render.

**Splitting** cuts at row boundaries only — anywhere else and the halves stop
lining up once they arrive as separate messages.

### Cropping, lettering, camera and drawings

A crop selection is held in fractions of the image, so it survives the preview
being redrawn at another size, and it is cut from the original before anything
is scaled: taking a tenth of a frame gives that tenth at full resolution.

Lettering, camera frames and drawings are all canvases, which is why the whole
pipeline applies to them without a single special case. There is no bitmap font:
text is drawn with the fonts the machine already has, at 200px per line, and
reduced by the same box filter photographs go through.

### Dots by hand

The algorithm does not always guess right. Clicking or dragging on the finished
art sets and clears individual dots, with undo on a button and on Ctrl+Z.

While editing is on the art stops following the controls. That is the bargain:
either it tracks the parameters or it is yours to touch up. Silently discarding
a minute of work because a slider moved would be worse than refusing to
recalculate.

### Keyboard

Three surfaces would otherwise belong to the pointer alone, which for a project
named after braille would be a poor joke.

**Cropping.** Arrows move the selection, Shift with arrows resizes it from the
far corner, Alt makes either step finer, Escape gives back the whole frame. The
layer only takes focus while it is active, so Tab never stops on an invisible
one.

**Dots.** Arrows move a visible cursor by one dot, Shift by a whole cell, Space
sets and clears, Ctrl+Z undoes. Dots rather than cells are the unit: moving a
cell at a time would leave four of every eight positions unreachable. The
pointer moves the same cursor, so the two never disagree about where "here" is.

**Drawing.** Arrows move the pen, Shift takes a wider step, Enter puts it down
and lifts it. Freehand is a pointer gesture by nature, but a whole source
reachable only by mouse is not an option.

A skip link leads straight to the art. The enlarged view is a real dialog:
focus moves into it and returns to whatever opened it.

### The interface

The page is exactly the height of the window and never scrolls itself. Four
areas — the original, the adjusted image, the pixels the encoder actually reads,
and the art — are visible together, by default as a 2×2 grid. Only the controls
column and the art contents scroll, each inside its own box. Previews are small
by necessity, so clicking one opens it full size at real resolution.

Simple and advanced are one DOM tree and one attribute: the mode decides only
what CSS shows, so there is no second interface to keep in step.

### Adding a language

Nothing outside `src/i18n/` holds a user-visible string: the markup carries keys
in `data-i18n` attributes and the code asks `t()` for everything it says. A new
language is one file beside `en.js` and one line in `LOCALES`.

Plural forms go through `Intl.PluralRules`, so a dictionary supplies only the
forms its own language uses — English needs two, Russian needs three. `{name}`
inserts a value as it is; `{#name}` groups it as a number, because 1234
characters should read as 1,234 while a frame 1280 pixels wide should not.

The suite checks that every dictionary answers every key, that every key the
markup asks for exists, and that everything named from data has a name.

---

## Layout of the source

```
index.html          markup and styles, inline, no external requests
src/
  core/             pure logic: no document, no canvas
    braille.js        ImageData -> text: dot map, cell grid, tonePlane
    gamma.js          sRGB, linear light, perceptual lightness
    dither.js         error diffusion, ordered matrices, local threshold
    bluenoise.js      a void-and-cluster threshold tile, built at load
    colour.js         average colour per cell, collapsed into runs
    edges.js          XDoG and Sobel, mixed with tone
    blur.js           separable Gaussian
    otsu.js           a threshold from the histogram
    adjust.js         tone and unsharp masking
    pixels.js         luma, clamping, fitting, cell geometry
    presets.js        control values per kind of image
  worker/
    pipeline.worker.js  the same core modules, off the main thread
    protocol.js         pixels across the thread boundary
  ui/                 everything that touches the DOM
    pipeline.js       one interface over worker and inline
    canvas.js         scaling, cropping, reading and writing pixels
    export.js         .txt, clipboard, PNG, SVG, HTML, ANSI
    platforms.js      message limits and width calibration
    settings.js       remembering the panel
    crop.js           the selection rectangle
    dots.js           editing individual dots
    text.js           lettering as a source
    camera.js         a frame from the webcam
    draw.js           a sketch pad
  i18n/
    index.js          t(), plural rules, applying keys to markup
    en.js, ru.js      dictionaries
  main.js           wiring
tests/              run in a real browser
sw.js               the offline shell
manifest.webmanifest
```

`src/core/` never touches the DOM and uses only `ImageData`, which exists in
workers too — so `pipeline.worker.js` imports exactly the same modules the page
does, not copies of them.

---

## Tests

```bash
node tests/run.mjs             # both pages
node tests/run.mjs pipeline    # just one
```

Chrome or Edge must be installed (`CHROME` overrides the path). Nothing else is
needed: no npm, no build, no dependencies.

They run in a real browser because that is where the things worth checking live:
workers, `ImageData`, font metrics. `tests/pipeline.html` checks the algorithms
and compares worker output against the main thread byte for byte;
`tests/page.html` drives `index.html` itself in an iframe, hands it a file and
confirms the art appears with nothing clicked.

Layout is measured rather than eyeballed: the suite takes the bounds of all four
panes and requires each to sit wholly inside the viewport, in every arrangement,
including at a 620px-tall window.

---

## Licence

The project changed licence partway through its history, and both remain in
force:

- versions **up to and including `v0.0.12`** — [MIT](LICENSE-MIT); that state is
  kept by the tag `v0.0.12-mit` and the branch `archive/mit-v0.0.12`;
- versions **from `v0.1.0`** — [GNU GPL v3.0 or later](LICENSE).

An MIT grant cannot be withdrawn, so everything published under it stays
available under MIT for good. See [`LICENSING.md`](LICENSING.md) for what that
means in practice.

Parts of the code were written with AI assistance — see
[`AI_NOTICE.md`](AI_NOTICE.md).
