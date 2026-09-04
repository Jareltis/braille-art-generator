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
| **Detail** | thin structure survives the reduction instead of being averaged away |
| **Dithering** | Floyd–Steinberg, Atkinson, blue noise, Bayer 4×4 |
| **Thresholds** | global, automatic by Otsu, and local adaptive (Sauvola) |
| **Edge detection** | XDoG for drawn strokes, Sobel for gradients, a slider between fill and lines |
| **Colour** | one tint per cell: on screen, in PNG, SVG, HTML and ANSI for the terminal |
| **Image adjustment** | brightness, contrast, saturation, sharpness |
| **Output** | width and height in cells, proportions kept automatically, inversion |
| **Presets** | photographs, line art, logos, pixel art — each sets every control it covers |
| **Detect the kind** | measures the picture and picks the preset for it, saying which way it went |
| **Suggest** | renders a spread of recipes, scores each against the picture, offers the best four |
| **Targets** | message limit in view, copying inside a code fence, width measured against your own client |
| **Fitting** | trim blank margins, find the widest size that fits, split into several messages |
| **Source** | a file, lettering in large braille type, the camera, or a drawing |
| **Loading** | file picker, drag and drop, paste with Ctrl+V |
| **Cropping** | drag a rectangle over the preview: empty space selects, inside moves, a corner resizes |
| **Editing** | set and clear individual dots on the finished art, with undo |
| **Two modes** | simple keeps five controls; advanced reveals everything |
| **One screen** | original, adjusted image, sampled pixels and the art are all visible at once |
| **Layouts** | 2×2 by default, strip on top, art-first, single row |
| **Sharing** | a link that reopens the generator with the same settings |
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

### Deciding a dot from the picture, not from a thumbnail

The order used to be: shrink the image to the grid, then decide each dot from
what survived. That throws the evidence away before the question is asked. A
one-pixel line in a photograph becomes a tenth of a level of grey and the
threshold never sees it — measured on a test frame, **none of it survived at
all**.

Now the encoder is handed a raster several times the grid, and reduction and
decision happen together: every source pixel under a dot is visited, and what
the dot learns is not only the average but the extremes. Visiting them costs
nothing extra — the average already had to touch every one.

Which of them speaks is decided per dot by how much structure is there,
measured as the gradient response after a light blur. That number separates a
real feature from noise: on a cell holding a one-pixel line it reads about 66,
on one holding only noise 24–30, and on a genuine boundary 115. A factor of
roughly 2.4 is enough to lean on but not enough to switch on, so the **Detail**
control blends rather than switches.

The result, measured:

| | flat field | noise ±50 | one-pixel line |
|---|---|---|---|
| shrink first (the old way) | — | — | **0% survives** |
| detail 0 | ±0.4 pp | +2.2 pp | 3% |
| **detail 35 (default)** | **±0.4 pp** | +4.4 pp | **100%** |
| detail 70 | ±0.4 pp | +6.7 pp | 100% |

An even field is untouched at any setting — the structure gate sees nothing and
the average stands. The price shows only on heavy noise, about two percentage
points of coverage, and it buys the thin structure back whole.

Lines are found on that same detailed raster and reduced to the grid by taking
the strongest value rather than the average: a stroke one pixel wide is the
whole point of the map it came from, and averaging is precisely what would
erase it again.

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
  with it. Its sixteen levels are the reason it holds a flat tone to within
  about three percent where the others are exact.

In both ordered methods the tile *is* the ladder of thresholds, spanning the
whole range, so a flat value lands above as many rungs as it is bright and
coverage comes out equal to the value. The threshold control shifts that ladder
rather than sitting at its centre: with no error being fed back there is nothing
to correct a bias, which is exactly how they drifted for nine versions after
tone moved to linear light — a flat mid-grey came out at 81% coverage instead of
50%, while error diffusion sailed through the same change because it corrects
itself.
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
- **Sobel** reports gradient magnitude: fast and predictable, but it answers
  "how steep is it here", so a slope answers across its whole width — measured,
  four pixels for a hard step and eleven for one that fades over eight. Only the
  crest is kept. A point survives if it is at least as strong as the two points
  either side of it *along* the slope, and those two are interpolated rather
  than snapped to the eight compass directions, which is what keeps a diagonal a
  line instead of a row of dashes. Both bands come back one pixel wide, at the
  strength they had.

  That thinning matters more than it used to. Line maps are reduced to the grid
  by taking the strongest value in each cell — averaging would erase the very
  stroke the map exists to report — so a band hands its peak to every dot it
  touches, and eleven pixels of slope became three dots of solid ink where one
  line belonged.

Both detectors answer to texture as readily as to a boundary, and no single
threshold tells them apart, because a blade of grass really is a sharp little
edge. **Clean-up** separates them by company rather than by strength: the
strongest responses are seeds, and a fainter one is kept only where it can be
traced back to a seed. A contour is a faint stretch continuing from a strong
one; texture is a speck whose neighbours are specks too.

Measured across six photographs and drawings, on a hillside it halves the ink —
37% of the frame down to 18% — while the median run of connected ink grows from
12 pixels to 30: less of it, in longer strokes. On a clean graphic the speckled
background disappears completely and the lettering is untouched, with the number
of separate pieces falling from 280 to 58.

It has a limit worth stating: it separates the weak-but-connected from the
weak-and-alone, so texture that answers as strongly as a contour is beyond it.
On a photograph of a forest, Sobel's dust is genuinely strong — every needle is
a real step edge — and cleaning barely moves it.

Two other approaches were measured and dropped. Surround inhibition eats strokes
from the middle outward, a strong stroke being its own surround, and the annulus
form that avoids that removes almost nothing from a photograph, where the ring
is as busy under a contour as anywhere else. Flow-based DoG was planned and then
not built: it addresses fragmented contours, and the measurement showed the
opposite problem — 93–97% of XDoG's ink was already in long strokes. There was
no fragmentation to fix, only too much ink.

τ is deliberately 1 rather than the ≈0.98 the XDoG paper uses for stylisation.
Below 1 the flat-field response is `l·(1−τ)` — proportional to brightness — so
an even mid-grey answers with ink and dark areas silt up with strokes that are
not edges.

### Suggesting variants

The controls span more combinations than anyone will sit and try, and which one
suits a given picture is not obvious even to someone who knows what every
control does. **Suggest** renders a spread, scores each against the picture, and
puts the best four on the table. Nothing is applied until one is taken; Escape
leaves everything as it was, down to the message in the status line.

The spread is drawn rather than listed, so pressing again is worth doing. Drawing
freely from the whole parameter space would mostly produce rubbish, so the draw
happens inside **families** — ways of working rather than settings: carry the
half-tones, lay an even grain, cut hard for contrast, threshold locally, draw the
lines, mix lines with tone. Which family a tile comes from is settled first and
only its dials are random: method within the family, detail, edge radius and
weight, and the threshold within about twenty levels of where it stands.

Then the four squares go to four *different* families where it can manage it,
which is what keeps a press from being the same tool four times with the dials
nudged. It is a reach, not a promise: a family takes a square only by scoring
within 55% of the best on the table, and on some pictures only three ever do —
then the fourth goes to the next best rather than to something nobody would
choose. Measured over six pictures at both widths, four distinct families came up
in 33 draws out of 36, and the weakest tile shown never fell below 58% of its
best. A press costs eighteen encodings, under a second in the worker at these
sizes.

Scoring is done the way a person does it — by leaning back. Up close the art is
a field of dots; at a distance the dots merge and either the picture is there or
it is not. So the dots are turned back into light, both sides are blurred by
about what the eye does at reading distance, and the two are compared. Coverage
is what makes that a fair comparison rather than a loose analogy: half the dots
raised emits half the light, which is the same linear quantity the photograph is
measured in.

The comparison has two halves, multiplied so that neither can carry a candidate
alone:

- **Structure**, as structural similarity over 8×8 windows: is the average
  right, is the amount of variation right, do the two vary together.
- **Tone**, as the plain difference between the blurred planes.

Structure alone is not enough, and the reason is worth stating. On a flat region
SSIM rewards having no structure, and something uniformly wrong has no structure
either: a hard threshold turns flat mid-grey into a solid field — 57 percentage
points of coverage out — and structural similarity alone still called it 0.73.

Two more things were measured rather than assumed. The viewing blur is 1.6 dots:
below about one dot the comparison sees individual dots and rewards whichever
method happens to land its dots on the right pixels, and the ranking inverts
outright; above about three it sees only average brightness and stops caring
whether the picture is in there. And the four offered must differ from one
another by at least 4% of their dots, or a picture that suits several recipes
spends all four places on the same image with a different grain.

Across six photographs and drawings at both 40 and 60 characters wide, error
diffusion wins or ties everywhere — 0.94 on a drawing, 0.89 on a landscape —
with ordered dithering and blue noise a few thousandths behind on the flattest
graphics. So the default is what the numbers say it should be, and the tiles are
there for the times a picture disagrees.

An earlier draft of this section claimed the opposite, on the strength of a
measurement made through a bench that had its own copy of the call into the
encoder. The copy passed detail in the units of the slider where the encoder
wants a fraction, rendering every candidate at a strength of 35 instead of 0.35,
which flattens error diffusion into solid blobs and inverts the ranking. The
bench now goes through the same function the application does, which is the only
version of this that stays true.

### Which kind of picture is this

Choosing between the presets means knowing which one applies, which is a
question about the picture rather than about the person holding it. **Detect
automatically** measures the picture and applies the preset that fits, and says
which one it settled on, because it is a guess and a guess should be
overrulable.

Four measurements do the work, and each threshold sits in the middle of a
measured gap rather than snug against one edge:

- **Repeated columns.** Pixel art is nearly always shown enlarged, and
  enlarging without smoothing duplicates every column: 96% of them, and still
  88% after the file has been through JPEG. A logo built of flat shapes reaches
  54%, a line drawing 21%, and six photographs 0–6%.
- **The ends of the scale.** Ink on paper lives at black and white: 77% of a
  logo and 90% of a line drawing sit near one end or the other, against 2–37%
  for everything photographic.
- **How much answers strongly.** That separates a drawing from a logo once both
  are known to be ink: a drawing is mostly strokes and a logo mostly fill —
  16% against 3%.
- Anything else is a photograph, which is both the commonest thing brought here
  and the least damaged by the guess being wrong.

The sample behind those numbers is small and honest about it: six photographs
and drawings, plus synthetic pixel art, a synthetic logo and a synthetic line
drawing, each also measured after a round trip through JPEG. Three of the four
kinds therefore rest on synthetic evidence.

One earlier feature was measured and dropped. Regularity of the spacing between
column changes reads 100% on clean pixel art and 0% on the same image saved once
as JPEG, because compression scatters extra changes between the block
boundaries. A feature that a single save destroys is worse than no feature.

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

### A link that carries the settings

The **Link** button copies a URL that opens the generator with the same recipe:
size, method, threshold, edges, tone, target, language, mode, layout. The
picture is not in it — only the settings.

They travel in the fragment rather than the query string, and a fragment is
never sent to the server, so on a static host a shared link discloses nothing to
whoever runs it. The keys are short but readable on purpose: `w=120` is the
width, and it can be changed by hand.

The address bar keeps up on its own, through `replaceState` rather than
`pushState` — the back button should not fill with every position a slider
passed through. A link outranks whatever this browser had stored, because
following one is a deliberate act. Lettering long enough to make the URL useless
is left out of it, and the message says so. A key this version does not know is
ignored rather than refused, so a link written by a later one still works.

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
    edges.js          XDoG and Sobel, thinning, mixed with tone
    blur.js           separable Gaussian
    otsu.js           a threshold from the histogram
    adjust.js         tone and unsharp masking
    pixels.js         luma, clamping, fitting, cell geometry
    presets.js        control values per kind of image
    classify.js       which of those kinds a picture is
    score.js          how much an art still looks like its picture
    variants.js       a spread of recipes, and which are worth offering
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
