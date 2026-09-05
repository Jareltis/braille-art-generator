# Braille Art Generator

[Русский](README.ru.md) · **English**

Turns an image into text made of **Unicode braille** glyphs (U+2800…U+28FF).
Each glyph encodes a 2×4 block of pixels, so it carries four times the detail of
ordinary ASCII art.

It runs entirely in the browser: the image is never uploaded, and the server
only ever hands out static files.

**[Open the generator →](https://jareltis.github.io/braille-art-generator/)**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Older versions: MIT](https://img.shields.io/badge/%E2%89%A4v0.0.12-MIT-green.svg)](LICENSE-MIT)

![The generator: original, adjusted image, sampled pixels and the finished art, all on one screen](docs/screenshot.png)

---

## What it does

| | |
|---|---|
| **Detail** | thin structure survives the reduction instead of being averaged away |
| **Dithering** | variable coefficients (plain or with a jogged threshold), Floyd–Steinberg, Atkinson, blue noise, Bayer 4×4, with optional edge emphasis |
| **Thresholds** | global, automatic by Otsu, and local adaptive (Sauvola) |
| **Edge detection** | XDoG for drawn strokes, Sobel for gradients, a slider between fill and lines |
| **Colour in the edges** | boundaries between colours of the same brightness, which brightness alone cannot see |
| **Colour** | one tint per cell, or two -- ink and a ground -- wherever there is a background to paint |
| **Palette** | full colour, the 256 or 16 a terminal has, or a few drawn from the picture |
| **Copying** | as text, or as a picture for rooms that squash the line height |
| **Sharing** | straight to another app, which on a phone is where the chat actually is |
| **On screen** | the art drawn dot by dot, so the font's gutters and hollow rings stay out of it |
| **Characters** | braille dots, or Unicode 16's solid blocks where the reader's font has them |
| **PNG** | drawn the same way, from the same function |
| **Image adjustment** | brightness, contrast, saturation, sharpness |
| **Output** | width and height in cells, proportions kept automatically, inversion |
| **Presets** | photographs, line art, logos, pixel art — each sets every control it covers |
| **Detect the kind** | measures the picture and picks the preset for it, saying which way it went |
| **Suggest** | renders a spread of recipes, scores each against the picture, offers the best four, and says what each would change |
| **Back and forward** | steps the whole panel through what the automatic changes did to it |
| **What was worked out** | the automatic choices in effect, and why each one is what it is |
| **On a phone** | the result first, the source views as a strip beneath it, controls below |
| **Spoken** | the art is a picture and says so, instead of being read out dot by dot |
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

The easiest way is to [open the hosted version](https://jareltis.github.io/braille-art-generator/).

Locally, any static server will do — the project is built from ES modules, and
browsers refuse to load those over `file://`, so double-clicking `index.html`
will not work.

```bash
git clone https://github.com/Jareltis/braille-art-generator.git
cd braille-art-generator
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
- **Variable coefficients** (Ostromoukhov, 2001) is the default. Floyd–Steinberg
  spreads its error the same way whatever the tone is, and in the highlights and
  shadows that produces the correlated patterns the trade calls worms. These
  weights — three neighbours instead of four — were fitted separately for each
  of 128 tone levels, off-line, so that the pattern's spectrum stays close to
  blue noise across the whole range; above the midpoint the table mirrors. They
  are copied from the paper's appendix because they cannot be derived here.
  Measured on four pictures at sixty columns it beat Floyd–Steinberg on every
  one — 0.901 to 0.907 on a landscape, 0.841 to 0.852 on a forest — and costs
  nothing worth counting at these sizes.
- **Atkinson** passes on only six eighths of the error. Losing the rest is the
  point: highlights and shadows clip rather than smear, which reads better on a
  coarse grid.

Both of these turn at the end of each row rather than flying back to the left.
Error diffusion that always travels the same way leaves the error drifting that
way too, and the drift shows as fine horizontal streaking through the mid-tones
— plain to see on a hillside, where the slopes came out combed. Alternating the
direction cancels it between one row and the next, at no cost at all. Measured,
the score against the original rose from 0.890 to 0.901 on a landscape and from
0.943 to 0.949 on a drawing, and fell by 0.002 on a graphic; the streaking is
the part you can see.
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
**Variable coefficients with a jogged threshold** is Zhou and Fang's follow-up to
Ostromoukhov: the same shape of table, refitted, plus a second one saying how
hard to push the threshold about at each level. Variable coefficients on their
own leave regular patterns in the mid-tones, and a level-dependent random jog
breaks them — safely, because error diffusion still measures its error against
the true value, so the neighbourhood puts the tone back. Measured over six
pictures at forty and sixty columns it scores above the plain coefficients on
nine of the twelve, by up to 0.011, and below on three, by up to 0.014. The
losses are all on the same drawing, where a jogged threshold puts noise into
flat colour — so it is offered rather than made the default, which by this
project's own rule needs a method that wins everywhere. The jog is seeded, so
the same picture comes out the same twice.

**Edge emphasis** leans on the threshold at an edge, after Eschbach and Knox:
subtract a scaled high-pass of the picture from it, so a pixel on the bright
side of an edge finds it easier to light and one on the dark side harder. One
multiply and one add per pixel.

It is a control and not a default, because the two things it does pull opposite
ways. Measured, the score against the original falls from 0.89 to 0.86 as it is
turned up — it is deliberately less faithful to the light. What it buys is
legibility, which that score cannot see: on a graphic with lettering, the word
reads at strength 1 and mushes into its background at 0. Both were looked at.
The logo preset turns it on because that is the case it was measured on.

Most of that cost used to be paid where there was nothing to sharpen: a
high-pass answers to speckle exactly as it answers to an edge, so at full
strength the threshold was being pushed about all over a hillside for no gain.
It is now scaled by how much structure is actually there — the same
gradient-after-a-blur the detail blend leans on, and cheap, since the plane is
already down at one value per dot. On a step buried in speckle of its own
strength, the lean in the speckle falls from 5.5 to 0.1 while the step keeps
22.0; over six pictures at forty and sixty columns the gated form scores at or
above the flat one on ten of the twelve. The gate halves the lean at an edge as
well, so the strength carries a measured factor of two to put the top of the
slider back where it was.

It reaches only the methods that hand their error to the neighbours. Those
measure their error against the true value whatever the moved threshold decided,
so the neighbourhood puts the tone back. An ordered tile has no such second
chance — moving its threshold moves the tone and nothing returns it, which is
exactly the trap the ordered methods were already caught in once. The control
greys out when a method that cannot do it is chosen.

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

That much was true from the start. What it could not do was separate a contour
from texture of the *same strength* — a blade of grass is a genuinely sharp
edge, and no threshold and no amount of connectivity tells the two apart. That
gap is now closed by asking a different question: not how strong the ink is, but
whether it points the same way as its neighbours.

The **structure tensor** answers that. The products of the gradient components
are smoothed into a small matrix at each point, and how far apart its two
eigenvalues sit says whether the energy there is all going one way. A boundary
pushes it one way and answers near 1; texture pushes it every way at once and
answers near 0. Measured on a straight edge buried in speckle of its own
strength: 0.72 on the edge against 0.02 in the texture, a gap of thirty-four
times, where the plain gradient managed 2.4. Over the ink XDoG lays on a
photograph, the most coherent tenth stands about twelve times above the least.

Cleaning therefore asks both questions, in that order: dim what the neighbourhood
does not agree about, then keep what is strong or joined to something strong.
Seeds are chosen from ink that has already been judged rather than from whatever
happened to be brightest, and what survives goes back to the weight the detector
gave it, so a surviving stroke is as dark as it earned.

On a landscape at sixty columns this takes the separate pieces of ink from 1001
to 493 and the median run of connected ink from 30 pixels to 61; on a drawing,
from 68 pieces to 27 and from 57 pixels to 161. Fewer marks, much longer.

It is not free. The three blurs behind the structure tensor are the largest
single cost in the edge path — 744ms of about 800 on a two-megapixel raster,
against 21ms for the hysteresis after it. Three ways of making it cheaper have been
measured and none was taken. Half resolution is four times faster and moves 30%
of the lit dots. Box blurs in place of the Gaussian are twice as fast and shift
the coherence itself by 0.07 to 0.14 on a scale of one. And a recursive
Gaussian — Young and van Vliet, a fixed handful of operations per pixel whatever
sigma is — is four to eight times faster on the blur and keeps a flat field
exactly flat, but measured against a properly computed Gaussian rather than
against our own approximation it is the less accurate of the two by about seven
times, with tails twice as heavy as they should be. For a tensor whose whole
question is how far agreement reaches, that is the wrong thing to get wrong; it
moved 1.4–3.1% of the lit dots to save half the time on this path, and the
truncated direct filter was already within half a level of the ideal at its
worst. What carries the cost
instead is the pacing — a redraw too slow to follow the controls stops following
them and says so.

Two other approaches were measured and dropped. Surround inhibition eats strokes
from the middle outward, a strong stroke being its own surround, and the annulus
form that avoids that removes almost nothing from a photograph, where the ring
is as busy under a contour as anywhere else. Flow-based DoG was planned, dropped, and later
built and measured after all. It was dropped the first time because it addresses
fragmented contours and the measurement showed the opposite problem: 93–97% of
XDoG's ink was already in long strokes. It was reconsidered once the structure
tensor arrived, since that gives the flow field FDoG needs for nothing extra —
and then measured properly, with the same cleaning applied to both so the
comparison was not between a tidied thing and an untidied one.

The result was a modest gain on a photograph — 342 separate pieces of ink
against 493, a median run of 86 pixels against 61, at the same ink — and none on
a drawing, which the cleaned XDoG already reduced to 27 pieces. Side by side the
two pictures are hard to tell apart. The detector costs eight times as much.
Both methods exploit the same fact, that an edge has a direction; having taken
the cheap way to use it, the expensive way adds too little to pay for itself.
That is a verdict on the marginal gain here, not on the method: without the
coherence gate it would very likely have been the right thing to build.

τ is deliberately 1 rather than the ≈0.98 the XDoG paper uses for stylisation.
Below 1 the flat-field response is `l·(1−τ)` — proportional to brightness — so
an even mid-grey answers with ink and dark areas silt up with strokes that are
not edges.

#### A boundary the light cannot see

All of the above reads brightness, and brightness is not all there is. Two
colours can be the same weight of light and nothing alike: a green continent on
a blue globe, red lettering on a green field. Measured, such a join moves the
lightness plane by 1 part in 255, the detector answers 7 out of 255, and the art
gets **no ink at all** — the shape is simply absent from a picture that plainly
has one.

**Look at colour as well** runs the same detector on the two colour axes of
L\*a\*b\* and combines the three by taking the largest, the way line maps are
always combined here — averaging would rub out a boundary only one channel can
see, which is the entire point. The axes are scaled by the same 2.55 as the
lightness plane, because in L\*a\*b\* a step of one along any axis is meant to
look about as big as a step of one along any other.

The colour is blurred first, four times as wide as the detector's own radius.
Chroma acuity is a fraction of luma acuity — which is why JPEG has been
discarding three quarters of the colour resolution since 1992 — so fine colour
detail is not detail, it is noise to find edges in. Measured over the six test
pictures, the softening is what keeps the gradient detector usable at all: its
ink goes up 1.9 to 3.3 times without it and 1.05 to 2 times with it. The stroke
detector is less exposed, its own blur having already discarded some of that
noise — 2.0 to 2.6 times against 1.6 to 2.5. Four is the middle that holds: at
eight the photographs settle further but the equiluminant join answers 40 out of
255 instead of 146, and at two both detectors are noisier than at four.

The coherence gate reads the same channels, for a narrower reason than it first
appeared. A straight colour join is perfectly directional in brightness too — at
a lightness step of 0.007 the gate still answers 1.000 — so nothing was being
thrown away there. What the brightness-only tensor cannot judge is a colour
stroke lying on brightness speckle: it answers 0.004 to the stroke, being
surrounded by noise pointing every way, where all three channels together answer
0.376. With colour in play the tensor sums its products across the three
channels — Di Zenzo's form, at no extra blurs — and the cleaning then keeps the
same stroke while taking a fifth more of the speckle with it. On the six test
pictures it moves 0.8% to 5.5% of the ink.

On the equiluminant join above this takes the answer from 7 to 146 out of 255,
and the art from no ink to a line. On a picture with no colour in it, the axes
are zero and nothing changes at all, which is checked. On a photograph it does
add texture ink, so it is off by default and the line-art preset switches it on;
the suggester treats it as one more dial to try. It costs 1.6 to 2.3 times the
line path, which the pacing already knows how to absorb.

### The same cell, written as blocks

Braille was chosen because every machine has it and because its cell is exactly
two dots across by four down. Unicode 16, in 2024, added the **octants**: the
same two-by-four cell drawn as solid blocks, with no gaps at all. Same grid,
same encoder, and in a terminal with the font it is simply the better picture.

The art stays braille. The blocks are a way of writing it out — the eight-bit
pattern of a cell is mapped to a character, and everything else in the app goes
on working on the braille it always had. The mapping is Unicode's own: the 230
characters of U+1CD00…U+1CDE5 in ascending order of the pattern, skipping the
twenty-six patterns that older block characters already cover — the full block,
the halves, the quadrants. All 256 have a character and no two share one, which
is checked.

The catch is the font, and it is a real one: measured on a Windows 11 machine in
2026, neither this app's own font stack nor plain `monospace` can draw a single
octant, while braille and the quadrants are everywhere. So the page checks
before it offers — it draws the character and the one code point guaranteed to
have no glyph anywhere, and compares the pixels — and where the font is missing
the option is switched off and says why. Hand editing steps aside while the
blocks are shown, since it counts dots in a braille cell.

One thing to know when pasting: a block outside the basic plane counts as two
characters in a limit that counts UTF-16, so the counter counts it that way too.

### The art is drawn, not typed

A braille glyph does not fill the cell it is given. Measured in this app's own
font stack, a fully lit cell inks 26 pixels of a 37.5 pixel advance: nearly a
third of every cell is blank, and the picture comes out ruled with vertical gaps
that belong to the font rather than to the art. The terminals that show braille
well — kitty, iTerm2, Ghostty, Konsole, VS Code — draw these glyphs themselves
for exactly this reason. Some fonts are worse than merely padded: they draw the
unraised dots as hollow rings, filling the picture with holes that were never
in it.

The obvious fix is the wrong one. Pulling the letters together with a negative
letter-spacing would even out the lattice, but it would also make the cell
narrower than a cell actually is: the gutter is missing ink, not a narrower
character, and every terminal that renders these glyphs well fills the cell
without changing its width. Squeezing the text hides a cosmetic flaw by
introducing a real one — and the glyph aspect that the row count, the layout and
both exports are all derived from would start to lie.

So the cell keeps the width the font gives it, and the dots are drawn inside it:
two across and four down, each in the middle of its own quarter, so the spacing
inside a cell and the spacing between cells are the same number. That is how the
PNG has always been written; since 0.35 it is what the page shows as well, out
of the same function, so the two cannot drift apart. The text is still there
underneath — it is what gets selected, copied, hand-edited and read out — and it
gives up only its colour while the drawing is up; select any of it and the
drawing steps aside so the highlight can be seen. **Draw the dots evenly** turns
it off, for anyone who would rather see exactly what their own font does.

Only the visible window is drawn: a full 900×700 of it measures 3.6 ms, which is
a scroll's worth of work rather than a render's. At small type sizes a dot is
drawn as a square rather than a circle — not because a square is sharper, since
an equal-area one peaks at the same value, but because near a one-pixel radius a
circle is almost entirely its own anti-aliased edge and the art greys out. In a
cell four pixels by eight, round dots lay down 4016 of ink where squares lay
down 5760.

The SVG draws its dots too, up to a point. Drawn is the better picture — the
same even lattice, no font in the chain — and it costs about 27 bytes a dot.
Measured on a landscape photograph, where roughly a third of the dots are
raised: forty columns comes to 118 KB, sixty to 259, a hundred and twenty to a
megabyte, four hundred to eleven megabytes, which is a file nobody opens. So
forty thousand raised dots is the line. Below it the SVG is shapes and looks the
same everywhere; above it the art is written out as text, a few kilobytes that
stay selectable and editable at the price of rendering in whatever monospace
font the viewer happens to have, gutters and all. The status line says which of
the two it just saved.

### For someone who cannot see it

Left to itself, a screen reader meeting the art reads out the braille patterns
one after another — several thousand of them, as dot numbers. For an app that
makes pictures out of braille that is worse than unhelpful, because the people
who read braille for real get the worst of it.

So the art says what it is: `role="img"` with a description built for this art
rather than left in the markup — where the picture came from, the size of the
grid, how many characters. The characters are then passed over rather than
recited. The count is given in the language's own plural forms, which for
Russian means 21 takes the singular.

While dots are being edited by hand the role comes off, because then the element
is not a picture but a thing being worked on, and the description says which
keys move and which toggle. The status line is already a live region, so each
edit is announced as it happens.

One thing this cannot fix, and it is worth saying plainly: art pasted into a
shared chat reaches anyone reading that chat on a braille display as noise. If
the room is not yours, a line of description alongside it is a kindness.

### Where the buttons are

Everything you can do with a finished art used to live in the settings column,
in one flat row of thirteen buttons between "measure your own chat" and the
edge controls. Two things were wrong with that. The buttons were nowhere near
the thing they act on — on a 390×844 phone, **Copy** sat about 1700px down, two
screens past the art — and they all looked equally important, so the row had to
be read from the start every time.

They now sit under the art, in three groups in the order they are reached for:
what to do with it (copy, copy as a picture, share, link), what to do to it
(suggest, recalculate, back, forward, edit dots), and what to save. The saves
are chips rather than buttons, because a file is a smaller act than a copy. On
the same phone **Copy** is now around 690px down — on the first screen, with the
art above it.

The status line moved with them. It used to answer from the top-left corner of
the page while the button was at the bottom of the middle column; now it sits in
the same row, where the eye already is. The header keeps what is used before the
art exists: the mode, and the language. **Layout** went into the display group —
it is set once, and on a phone it does nothing at all.

### Light and dark

The page was dark whatever the system said, which is a poor answer for anyone
whose system says otherwise, and for eyes that read light-on-dark badly. It now
follows `prefers-color-scheme`, with **Theme** offering the two explicitly for
anyone who wants the other one.

The palette was already a set of custom properties, so the light theme is those
properties read the other way round — paper rather than ink — with the accent
taken darker, since the green that carries white text does not carry black on
white. The two sets are written out twice rather than switched by a class,
because a class is set by script and script arrives late: the page would show
its dark self for a frame first.

The art follows without being told. The dots are drawn in `--ink` and the
exports read the same properties off the page, so a light page means dark dots —
in the pane, in the PNG, and in what gets copied as a picture. Three fixed dark
fills had to become a property first: the well a preview sits in was a third of
black, which on a white page is a grey slab.

### On every screen

Measured across twelve sizes rather than assumed: a folded phone at 320×568, a
small one at 360×640, ordinary ones at 390×844 and 430×932, a phone held
sideways at 844×390, tablets both ways up, a laptop, 1920×1080, an ultrawide at
2560×1440, a short window at 1440×620, and a tall narrow one at 480×1200.

What is checked at each: does the page scroll sideways (never), does the desktop
still hold everything without scrolling at all (yes, from 1024×768 up), and is
the first thing anyone wants to do — copying — on the first screen. That last
one failed in exactly two places, both of them short: the folded phone put the
button 65px below the fold and the sideways phone 81px below it.

A finger is not a mouse pointer, and the buttons were built for a pointer: the
smallest was 36×30 and a checkbox 16×16, against the 44 Apple asks for and the
48 Material does. Where the pointer is coarse — which is the right question, a
touch laptop being 1440px wide and a narrow desktop window not being touched at
all — controls take a floor of 44, the secondary chips 40, and checkboxes 24.

The rule is a media query this browser will not match — emulating a small screen
does not make a page think it is being touched — so the suite lifts the rules
out of the query and applies them for real, then measures. That tests what they
do rather than that they exist, and deleting them takes the smallest button from
44 back to 29, which is checked by deleting them.

That costs height, and height was already the thing the short screens did not
have: at 44 the button went back under the fold on a 360×640 phone. So the
short-screen rules start at 700px of height rather than 620, and a third tier
below 430 gives up more again. All twelve sizes land the button on the first
screen with a finger on the glass.

Type sizes are in `rem` rather than pixels, so a reader who has told their
browser to use bigger text gets bigger text — which is a setting pixels ignore
entirely, page zoom being a different thing that always worked. What must not
happen then is the page falling apart, so the art gives up its own height to
make room: at 150% it goes from 371px to 268 and the button stays on the screen,
at 200% from 371 to 320 and it still does. On a desktop nothing is given up at
all, because there was room to begin with.

There is a stylesheet for paper as well. Printing this used to put the whole
control panel on the page; now the panel, the buttons and the source views stay
off it, and the art prints as ink on white however dark the screen was.

Screens with little height now give a little from everywhere above the button:
the art takes 34vh instead of 44, the source views shrink to 52px thumbnails,
the rows close up. The art stays the largest thing on the screen, which is
checked too, and both sizes now land the button with room to spare — 514 of 568,
370 of 390.

### On a small screen

Below 900px the page stops trying to hold four panes at once and scrolls. That
much was always true; what was wrong is that it scrolled in source order, so the
art sat below the entire control panel. Measured on a 390×844 screen, the result
began 2163px down — two and a half screens past every control, on the one device
most people would be sharing from.

The result now comes first, and the three source views become a strip of
thumbnails beneath it rather than three more full-height panes. They are for
checking, not for reading. Between 620 and 900px — a landscape phone, a tablet —
the controls flow into two columns instead of one stack of fields stretched
across the whole screen.

None of this is a second interface: it is the same markup with a different
order, which is the same rule the Simple and Advanced modes follow.

**Share** belongs to the same screen. On a phone the chat is not on the
clipboard, it is behind the share sheet, so the art can go straight to another
app as a picture — the drawn one, so the room's own font never gets at it. A
browser that shares text but not files is handed the art as text instead, and
the status line says which of the two went; saying "shared" about the wrong one
would be a lie. Where there is no share sheet at all the button is not shown,
rather than sitting there unable to answer.

The picture is built with `toDataURL` rather than the tidier `toBlob`: sharing
has to happen while the tap that started it still counts, and on iOS an await
between the two loses it.

### Keeping work

Two places, because they answer different questions. **Save here** puts the work
in the browser's own database: the settings, the art as it stands, and the
picture it was made from — without that last one a saved work could be looked at
but never worked on again, which is not what saving means. **To a file** writes
the same thing as one JSON with the picture inside it as a data URL, which is
what makes it a file rather than an archive format. It opens by being dropped on
the page, the same gesture as dropping the picture it holds, or through the
button for anyone who would rather browse. Base64 costs a third more
bytes; not needing a zip library is worth that.

The gallery is IndexedDB rather than `localStorage` because a photograph is
megabytes and `localStorage` holds five of them in total, as strings. It is not
cookies either, and would not be: cookies are sent to the server with every
request, which for a static site means handing the host what someone is working
on, and four kilobytes is not a picture.

Each saved work carries a small drawing of itself, made by the same function
that draws the page and the PNG, so a thumbnail cannot show something the art
does not. A name and a grid size tell two works apart only when they differ; a
picture of the art tells them apart always, and at a hundred pixels across the
shape of a photograph is still legible. It costs a couple of kilobytes beside a
source picture measured in megabytes. The size shown beside the count is what
the works themselves take, not what the origin does — the offline cache is tens
of megabytes and would drown them.

**Save the style** puts the same record in without the picture or the art: how
to make one rather than what was made. It lands in the same list, marked as a
style and carrying no thumbnail, since there is nothing to show; opening it puts
those settings on whatever picture is loaded now. That is the difference worth
having — a saved work is a thing you made, a saved style is the way you make
them.

The panel says plainly that the browser is not a safe place to leave something.
A private window forgets it, "clear site data" takes it, and iOS discards
everything a site stored after seven days away unless the site was installed.
That is why the file exists beside the gallery rather than instead of it.

None of this involves an account, and it cannot: a static page has no way to
hold a GitHub login. The web flow needs a client secret, which means a server;
the device flow's token endpoint refuses browser requests outright. The
remaining option — asking someone to paste a personal access token into a web
page — is a worse idea than it looks. GitHub hosts the app and serves it offline
as a PWA; where the work goes afterwards is the file's business.

### Offline, and actually up to date

The app is static and has no backend, so the whole shell is precached and served
from the cache: that is what makes it work offline and open instantly.

Stopping there was a mistake with a long tail. The cache is keyed by a version
written into the service worker by hand, and a browser only reinstalls a worker
whose file has changed — so a release that touched no module left both the
worker and the cache alone, and anyone with the app installed went on being
served the shell they first cached. That string was written once and never
changed again: twenty releases, five of the last seven touching nothing the
worker would notice. Nothing anywhere said so.

There are two defences now, because either alone has a hole. The version lives
in `src/version.js`, is shown in *What was worked out*, and the test suite fails
if the worker disagrees with it — a forgotten bump breaks the build rather than
the user. And a cached answer is now refreshed in the background after it is
served, so even a worker that never changes cannot serve last month's app twice.
A whole page load still comes from whatever the cache held when it began, so the
modules on any single load are a matching set; new ones take effect on the next
visit.

### Saying what was worked out

A good deal is now decided for the person holding the picture: the kind of image
and the preset that follows from it, the threshold when Otsu is asked, how the
lines are cleaned, whether a redraw still keeps up. Every one of those was
announced once in the status line and then gone.

**What was worked out** lists them, in the present tense, as state rather than
as a log: the kind of picture and whether it was found or chosen, the threshold
and whether Otsu picked it or a hand did, the chain from source pixels through
the detail raster to the grid, whether redraws are following the controls and
what the last one cost, what cleaning is doing, and **what copying it as text
will carry**. That last one is there because it is easy to get wrong in a way
the picture on screen hides: colour never survives a paste, which is harmless
for the ordinary art — the dots carry it alone — and fatal for the mosaic, whose
dots say which of two colours a spot belongs to rather than how bright it is. As
plain text a mosaic is grey mush. The blocks travel, but only as far as the
reader has a font for them. Copying and saving as text say the same thing at the
moment it matters, rather than only in the panel. Anything the app did not
decide for itself says so plainly rather than being left out — a missing line
reads as a fault.

It has to be exactly right to be worth having. Writing it caught the app
crediting Otsu with a threshold a preset had set, because the flag that
remembers where the number came from was only cleared when the slider moved by
hand.

Alongside it, the keys: **Ctrl+Enter** recalculates and **Ctrl+Shift+C** copies.
The plain Ctrl+C is deliberately left alone — taking it would break copying out
of the lettering box, and it means the same thing everywhere else.

### Keeping up with the sliders

The art redraws as the controls move, up to the point where a redraw stops
feeling like one. That point used to be a cell count — two hundred by two
hundred — picked on one machine, which is the wrong unit for the question: the
same grid is under half a second on a laptop and several seconds on a phone. It
now comes from what the last redraw actually cost, scaled to the size being
asked for. Dithering walks every dot once, so cost against cell count is close
enough to a straight line, and the estimate only has to be right about which
side of half a second it lands on. There is a gap between the point where it
stops following and the point where it starts again, or a grid sitting exactly
on the line would start and stop on alternate keystrokes.

Redraws are also serialised, which matters more than the pacing. Coalescing by
animation frame merges the events of a single frame and then lets the next frame
start another redraw whether or not the last has finished — so dragging a slider
queued one redraw per frame, each of which the worker computed in full and the
page then discarded as stale. A request that finds one already running now
leaves a note instead, and the settings are read afresh when that note is picked
up. Measured on a landscape photograph: 380ms for a 200×150 grid, 640ms for
300×225.

### Stepping back

Three things rewrite the whole panel in one go: picking a preset, letting it
work out the kind of picture, and taking one of the offered variants. **Back**
and **Forward** step through those, restoring whole settings rather than
individual controls, since whole settings are what those actions replace.

They are also how one art is compared against another: step back, look, step
forward. That was chosen over a hold-to-peek toggle, which would have to show
one art while the panel described a different one — and would hand the wrong
thing to anyone who pressed copy at that moment.

Ctrl+Z and Ctrl+Shift+Z do the same, except while dots are being edited by hand:
there the chord belongs to the dots, which is what the hand is on.

### Suggesting variants

The controls span more combinations than anyone will sit and try, and which one
suits a given picture is not obvious even to someone who knows what every
control does. **Suggest** renders a spread, scores each against the picture, and
puts the best four on the table. Nothing is applied until one is taken; Escape
leaves everything as it was, down to the message in the status line.

The spread is drawn rather than listed, so pressing again is worth doing. Drawing
freely from the whole parameter space would mostly produce rubbish, so the draw
happens inside **families** — ways of working rather than settings: carry the
half-tones, lay an even grain, cut hard for contrast, draw the lines, mix lines
with tone. Which family a tile comes from is settled first and only its dials
are random: method within the family, detail, edge radius and weight, and the
threshold within about twenty levels of where it stands.

A drawing is judged by a different question, because it answers one. Scored
against the light, every line variant came out at 0.00 — light is the one thing
a line drawing does not reproduce — and across 48 draws on four pictures not one
was ever offered, in the version immediately after the one that had made those
lines good. So a drawing is measured on where its ink landed instead: precision
and recall against the picture's own contours, as one number. The two scales
turned out comparable without being made to be — drawings reach 0.88–0.96 on
their measure where tonal variants reach 0.84–0.94 on theirs — but they are not
raced against each other, because they answer different questions. Ranking on
light stays the house rule, and a drawing takes one place by earning it: it must
find the contours better than the best tonal candidate already does. On a smooth
gradient, where there is nothing to draw, it takes no place at all.

The local threshold used to be a family and is not any more. Its purpose is to
throw the illumination away so the content stays legible, which is the opposite
of reproducing the picture, so neither measure rewards it — measured, it took a
square exactly never, including on pictures deliberately lit from one side. A
family that cannot be offered is a promise this list does not keep. Sauvola is
still there to be chosen by hand, and its window is now an eighth of the shorter
side rather than a sixteenth: measured on three pictures, the old radius was
consistently too tight, costing a landscape 28%.

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

### A colour behind the dots

As text a braille cell is one glyph and carries one colour, so the unraised
dots are simply whatever the page is. That is most of the colour error: measured
over six pictures as the mean CIE distance between a dot and the colour it
should have had, one tint on a shared background is **24 to 36** out. The eye
reads a picture out of it because the tone is right, not because the colours
are.

Anywhere with a background as well as a foreground — the page itself, the PNG,
the HTML file, a terminal — the cell can carry two, and the same measurement
falls to **4.3 to 7.9**. Nothing about the dots changes: they are still decided
from luminance alone, and **and a colour behind them** only says what to do with
the ones that were left unraised. The run-length painting had to learn that a
run now needs both colours to match, or one cell's ink would be painted over
another cell's ground.

Going further — **let colour choose the dots** — splits each cell's eight dots
between the two colours that fit them best, k-means with k=2 in L\*a\*b\* started
from the two furthest apart, which for eight points is a handful of comparisons
rather than an optimisation. That reaches **2.0 to 3.8**, the closest of the
three, and it is a mode of its own because it is a different kind of picture.

The dots stop carrying tone. Every cell is split between its two colours, so
roughly half of them are raised wherever you look: measured on a landscape, the
usual art covers 0.30 of its dots with a spread of 0.28 from cell to cell, and
this covers 0.51 with a spread of 0.18. On a plain ramp the spread goes from
0.50 to 0.00. Pasted somewhere with no colour it is grey mush; with the colours
it is the most faithful picture the grid can carry. Nothing else in the panel
applies to it — the method, the threshold and the lines all answer questions it
does not ask — and the brighter of the two groups is the raised one, so
inversion still means what it means everywhere else.

What this cannot do is help a chat: plain text has no background, so pasting is
unchanged. It is for the picture, the page and the terminal.

### Fewer colours, on purpose

Colour leaves here in two directions, and both want the same operation. A
terminal may have only 256 entries, or 16, and sending twenty-four-bit codes to
one that cannot read them does not degrade gracefully: the escape sequences are
printed as text. The other direction is taste — a picture cut to eight colours
reads as a deliberate thing rather than as a photograph that lost.

So there is one control and one code path. What differs is only where the
palette comes from: fixed for a terminal, drawn from the picture by median cut
otherwise. Cells are snapped as they arrive, before anything downstream sees
them, so the screen, the HTML, the PNG, the SVG and the terminal cannot disagree
about what colour a cell is.

Median cut is where the palette starts, not where it ends. It chooses boxes and
puts an entry at the average of each; it never asks the question after that one
— given where the entries ended up, which colours actually belong to which, and
is that entry still in the middle of them? Since 0.52 that question is asked, a
dozen times or until nothing moves. Measured over six pictures at six grid
sizes, it takes a tenth off the colour error — 12.91 to 11.64 mean ΔE — and it
is better on 36 cases out of 36 and worse on none.

The middle of a cluster is its mean **in L\*a\*b\***, not in linear light. That
looks like a contradiction of the rule kept everywhere else here and is not:
averaging light is right when the answer has to give off the light of what it
stands for, which is what a cell's own colour does. Here the answer has to sit
as close as it can to a set of colours in the space the distance is measured in,
and that is the mean in that space.

The fit is made to eight thousand cells rather than to all of them, taken by
stride so the same picture always gives the same palette: measured, the sampled
fit is no worse than the complete one (11.64 against 11.77) and it turns 311 ms
into 15 ms on the largest grid this app will draw. It is fitted to both of a
cell's colours, ink and ground, because both are snapped to it — a palette that
had only ever seen the ink could leave a cell's ground on a colour that nothing
in the picture is behind.

Matching is done in **L\*a\*b\***, not by distance between sRGB numbers. Straight
RGB distance treats a step in dark green as the same size as a step in pale
yellow, and the eye does not. This is plain CIE76 rather than the later
refinements: for choosing among 256 fixed entries the difference between them
does not show. Median cut splits on sRGB channels as the method assumes, but
averages each box in linear light — averaging gamma-encoded channels gives a
result systematically too bright, which is the same mistake the dithering path
was written to avoid.

The xterm palette contains duplicates — entry 16 is black again, 231 is white
again — and a tie goes to the lower index, which is also the better answer: the
plain sixteen are understood everywhere.

PNG and SVG can also be exported on a transparent background.

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
    palette.js        fewer colours: terminal palettes and median cut
    score.js          how much an art still looks like its picture
    variants.js       a spread of recipes, and which are worth offering
  worker/
    pipeline.worker.js  the same core modules, off the main thread
    protocol.js         pixels across the thread boundary
  ui/                 everything that touches the DOM
    pipeline.js       one interface over worker and inline
    canvas.js         scaling, cropping, reading and writing pixels
    export.js         .txt, clipboard, PNG, SVG, HTML, ANSI
    lattice.js        the dots, drawn: on the page and into the PNG
    pace.js           whether a redraw still keeps up with the sliders
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
