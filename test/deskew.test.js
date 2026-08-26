const assert = require('assert');
const zlib = require('zlib');
const { PDFDocument, PDFName, PDFArray, PDFRef, rgb } = require('pdf-lib');
const { splitPdfBytes } = require('../split-core');
const { measureSkew, deskewPdfBytes, otsuThreshold } = require('../deskew-core');

const W = 700;
const H = 900;

// a page of text lines, tilted by `degrees` (positive tilts them down to the right)
function textPage(degrees) {
  const gray = new Uint8Array(W * H).fill(255);
  const slope = Math.tan(degrees * Math.PI / 180);
  for (let row = 0; row < 24; row++) {
    const baseline = 110 + row * 30;
    const end = row % 5 === 4 ? 400 : 600;
    for (let x = 100; x < end; x++) {
      const y = Math.round(baseline + (x - W / 2) * slope);
      for (let t = 0; t < 6; t++) {
        const yy = y + t;
        if (yy >= 0 && yy < H) gray[yy * W + x] = 20;
      }
    }
  }
  return gray;
}

async function makeSpread() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([800, 600]);
  for (let k = 0; k < 3000; k++) {
    page.drawRectangle({ x: k % 800, y: (k * 7) % 600, width: 3, height: 3, color: rgb(0.4, 0.4, 0.4) });
  }
  return doc.save();
}

function streamText(context, ref) {
  const stream = context.lookup(ref);
  const raw = stream.getContents();
  const filter = stream.dict.get(PDFName.of('Filter'));
  const bytes = filter ? zlib.inflateSync(Buffer.from(raw)) : Buffer.from(raw);
  return bytes.toString('latin1');
}

function matrixOf(text) {
  const match = text.match(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/);
  assert.ok(match, `no cm operator in ${JSON.stringify(text)}`);
  return match.slice(1).map(Number);
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

async function run() {
  // 1. a known tilt is measured back, in both directions
  [1.7, -2.4, 0.6, 4].forEach((tilt) => {
    const found = measureSkew(textPage(tilt), W, H);
    assert.ok(Math.abs(found - tilt) < 0.15,
      `tilted ${tilt}°, measured ${found}°`);
  });

  // 2. a straight page is left alone
  assert.strictEqual(measureSkew(textPage(0), W, H), 0, 'a straight page needs no correction');

  // 3. pages with nothing to measure must not be guessed at
  assert.strictEqual(measureSkew(new Uint8Array(W * H).fill(255), W, H), 0, 'blank page');
  const noise = new Uint8Array(W * H);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256;
  assert.strictEqual(measureSkew(noise, W, H), 0, 'noise is not text');

  // 4. Otsu separates ink from paper rather than picking a fixed threshold
  const dim = new Uint8Array(W * H).fill(180);
  for (let i = 0; i < dim.length; i += 3) dim[i] = 90;
  const threshold = otsuThreshold(dim);
  assert.ok(threshold >= 90 && threshold < 180, `threshold ${threshold} must split the two peaks apart`);

  // 5. the correction rotates about the centre of the page and nothing else moves
  const split = await splitPdfBytes(await makeSpread(), { split: 0.5 });
  const straight = await deskewPdfBytes(split, [1.5, -1.5]);
  const out = await PDFDocument.load(straight);
  assert.strictEqual(out.getPageCount(), 2, 'deskew must not change the page count');
  const box = out.getPage(0).getMediaBox();
  assert.deepStrictEqual([box.x, box.y, box.width, box.height], [0, 0, 400, 600], 'boxes stay put');

  const context = out.context;
  const contents = out.getPage(0).node.get(PDFName.of('Contents'));
  assert.ok(contents instanceof PDFArray && contents.size() === 5,
    'the split already wraps the stream in q/Q, so deskew adds two more around it');

  const m = matrixOf(streamText(context, contents.get(0)));
  const cx = 200, cy = 300;
  const centre = apply(m, cx, cy);
  assert.ok(Math.hypot(centre[0] - cx, centre[1] - cy) < 1e-6, 'the centre is the pivot');
  const moved = apply(m, cx + 100, cy);
  const angle = Math.atan2(moved[1] - cy, moved[0] - cx) * 180 / Math.PI;
  assert.ok(Math.abs(angle - 1.5) < 1e-6, `expected a 1.5° turn, got ${angle}°`);
  assert.ok(Math.abs(Math.hypot(moved[0] - cx, moved[1] - cy) - 100) < 1e-6, 'no scaling');

  // 6. the halves keep sharing one copy of the scan even with different angles
  const otherContents = out.getPage(1).node.get(PDFName.of('Contents'));
  const shared = contents.get(2);
  assert.ok(shared instanceof PDFRef, 'the original content stays an indirect reference');
  assert.strictEqual(shared.toString(), otherContents.get(2).toString(),
    'both halves must still point at the same content stream');
  const otherAngle = matrixOf(streamText(context, otherContents.get(0)));
  assert.ok(Math.abs(otherAngle[1] + m[1]) < 1e-9, 'the two halves are turned opposite ways');
  assert.ok(straight.length < split.length * 1.05,
    `wrapping should be nearly free: ${split.length} -> ${straight.length}`);

  // 7. a page without an angle is not touched at all
  const untouched = await PDFDocument.load(await deskewPdfBytes(split, [0, 0]));
  assert.strictEqual(untouched.getPage(0).node.get(PDFName.of('Contents')).size(), 3,
    'no wrapper when there is no correction');

  console.log('all assertions passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
