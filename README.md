# Book Scan Splitter

Everything a raw book scan needs before it is readable: cut apart, straightened, turned
the right way up, trimmed. In your browser, with nothing uploaded and no page limit.

Book scanners produce one image per *spread*: two pages side by side on a single sheet,
usually a little crooked, usually with a black border the lid left behind. Online tools
that cut them apart stop at 50 or 100 pages and want your book on somebody's server
first. Book Scan Splitter does the whole job on your own machine, on a 900-page scan if
you like:

- **Cut** every spread in two, left/right or top/bottom, in reading order, left to right
  or right to left for Arabic, Hebrew and Japanese books.
- **Straighten** each page, both halves of a spread measured separately, because a book
  on a scanner rarely lies with both of its pages at the same angle.
- **Rotate** the whole document, or only its odd or its even pages, for the scanners that
  lay every second sheet down the other way round.
- **Trim** the scanner's black borders, by hand or measured for you.
- **Keep only part of the book** and drop the rest, image data and all.
- **Look at the result** before you save anything.

None of it re-renders your scan: the bytes of the image that go in are the bytes that
come out.

**The one thing missing is OCR.** What you get back is a picture of a page, cut and
straightened, not searchable text. It is an ordinary PDF, so any OCR tool will take it
from there.

**→ [Open Book Scan Splitter](https://it-stoic.github.io/book-scan-splitter/)**

![Book Scan Splitter with a scanned book loaded](docs/screenshot.png)

## Use it

1. Open the link above.
2. Drop your PDF on the page.
3. Position the cut line over the book's gutter, or press **Find edges and gutter**.
4. Press **Preview result** to check the first pages.
5. Press **Split and save PDF**.

A 100-page scan comes back as a 200-page PDF, one book page per PDF page, in the right
order. Nothing to install, nothing to configure.

### Keep it as an app

In Chrome or Edge the page offers an **Install as an app** button. Press it and Book
Scan Splitter gets a desktop icon and a Start-menu entry, opens in its own window
without an address bar, and **works with no internet connection at all** — the whole
app is stored on your machine on first use. Uninstalling is a normal app uninstall. No
administrator rights are needed, so it also works on locked-down office machines.

### Is my book uploaded anywhere?

No. The page is downloaded to your browser and does the work there; your PDF is opened
from your disk, cut, and saved back to your disk. It never travels to a server — there
is no server. You can check this yourself: disconnect from the internet, then split a
book. It still works.

## Controls

**All pages overlaid** — up to 16 pages sampled across the book are drawn on top of each
other with a `darken` blend, so every pixel shows the darkest value any page has there.
You see the text block and gutter of the whole book at once, which makes it obvious
where a cut line is safe for *all* pages rather than just the one you happen to be
looking at. **Single page** steps through pages one at a time.

**Cut** — **left / right** for the usual spread, **top / bottom** for sheets that hold
one page above the other, which is what a landscape scan of a small book looks like.

**Find edges and gutter** — measures the overlay: the bright rectangle inside the
scanner's black border sets the four margins, and the gutter is found in the middle of
it, either as the dark band of the binding's shadow or as the widest white gap between
the two text blocks. It fills in the controls; look at the result before saving, because
a scan with no clear gutter can fool it.

**Cut line** — drag the green line, use the slider, type an exact percentage, or nudge it
with the arrow keys (hold <kbd>Shift</kbd> for larger steps).

**Outer margins** — drag the four dashed edges inwards to trim the black borders a
scanner leaves around the sheet. The area being discarded is greyed out.

**Rotate** — turns the whole document, 90° at a time. Nothing is re-rendered: the output
pages carry a `/Rotate` entry, exactly what a scanner writes when it stores a rotated
page. The cut line and margins turn with the view, so the cut stays on the same part of
the paper. **Applied to odd or even pages only** fixes the scanners that lay every second
sheet down the other way round.

**Straighten crooked pages** — measures how far each output page is tilted and turns it
back. The measurement is the classic projection profile: the page's ink is rotated
through candidate angles and the sharpest horizontal profile wins, because straight text
lines pile up into tall spikes while crooked ones smear across many rows. It runs *after*
the cut, so the two halves of a spread are measured and corrected separately, which is
the whole point: a book on a scanner rarely lies with both of its pages at the same
angle. A page with nothing to measure, a full-page photo or a blank, is left alone rather
than guessed at. Measuring means rendering every output page, so this is the one control
that costs real time on a long book.

**Pages** — process only part of the book. The pages outside the range are dropped
together with their image data, so a chapter out of a 900-page scan is a small file.

**Right-to-left book** — emits the right half of each spread first, for Arabic, Hebrew
and Japanese books.

**Preview result** — cuts the first few spreads only and shows the first 10 output pages
as they will be saved. It runs the same code as the real split, so what you see is what
you get, without waiting for the whole book.

## How it works

The interesting part is what Book Scan Splitter *doesn't* do: it never re-renders your
scan.

Every output page is a PDF page dictionary pointing at the **same** `/Contents` and
`/Resources` as the original spread, with its own `/MediaBox` and `/CropBox` covering
one half of it. The two halves of a spread reference one shared copy of the scanned
image. Consequences:

- **No quality loss.** Nothing is rasterised, recompressed or re-encoded — the bytes of
  your scan are the bytes in the output.
- **No size explosion.** The image data is stored once and referenced twice, so the
  output file stays roughly the size of the input instead of doubling.
- **Fast.** A few hundred pages take about a second; the slow part is writing the file.

`/Rotate` is honoured, so the cut line follows what you see on screen rather than the
raw box coordinates — scanners frequently store a rotated page rather than rotated
pixels, and cutting on the wrong axis is the classic way to get this wrong.

Straightening works the same way. `/Contents` may be an *array* of streams that a viewer
concatenates, so each half gets `[q … cm, the original stream, Q]`: two tiny streams
wrapped around one shared copy of the scan, rotating it about the centre of the crop box.
The image data is still stored once and referenced twice even when the two halves are
turned by different angles, and the correction costs a couple of hundred bytes per page.

Rendering the preview is [pdf.js](https://github.com/mozilla/pdf.js); writing the output
is [pdf-lib](https://github.com/Hopding/pdf-lib). Both are vendored into `vendor/`, so
the page loads nothing from any third party.

## Without a web server

The app is plain static files and also runs straight off a disk or USB stick: download
the repository and open `index.html` in a browser. Copy the whole set, keeping the
layout — the paths between them are relative:

```
index.html
app.js
style.css
split-core.js
deskew-core.js
vendor/            pdf.min.js, pdf.worker.min.js, pdf-lib.min.js
```

Opened this way, pdf.js cannot start a web worker and renders the preview on the main
thread (it logs *"Setting up fake worker"* — expected, not an error), so previews of
very large scans appear page by page. Splitting is unaffected. The app-install button
and the offline cache only exist on the hosted version.

## Limits

- The file is held in memory, so extremely large scans (well past ~1 GB) can exhaust the
  browser tab.
- Password-protected PDFs are not supported.
- One cut line applies to the whole document. A page that needs a different one has to
  be handled in a second pass over its own page range.
- Straightening turns a page about its centre, which empties the corners and can pull a
  sliver of the facing page in at the gutter; the outer margins are there to trim both.
  Only tilt is corrected, not the curvature a thick book shows near its binding.

Tested in Chrome. Edge shares the same engine; Firefox and Safari use nothing exotic
here but have not been verified. The install button is a Chrome/Edge feature — in other
browsers the page simply works as a page.

## Development

```sh
pnpm install
pnpm test      # geometry, all four /Rotate angles, both cut directions, ranges,
               # skew measured back off known tilts, output size
pnpm vendor    # refresh vendor/ from node_modules
```

`split-core.js` holds the splitting logic and `deskew-core.js` the straightening; both
are shared verbatim by the page and the test suite, and `app.js` is only the interface. There is no build step — the page loads
plain scripts, which is also why the vendored libraries are the UMD builds rather than
ES modules (`file://` pages cannot load ES modules).

**Deployment** is GitHub Pages, driven by [.github/workflows/pages.yml](.github/workflows/pages.yml):
every push to `main` uploads the repository as it stands and deploys it. The workflow
declares `pages: write` and `id-token: write` explicitly, so it does not depend on the
repository default for `GITHUB_TOKEN`.

**After changing any app file, bump `CACHE` in `sw.js`** (`book-scan-splitter-v1` →
`book-scan-splitter-v2`). Installed copies serve the cached version until the cache name
changes, so skipping this means users keep running the old build.

## License

MIT, see [LICENSE](LICENSE).

## Credits

- [pdf.js](https://github.com/mozilla/pdf.js) — Apache-2.0
- [pdf-lib](https://github.com/Hopding/pdf-lib) — MIT
