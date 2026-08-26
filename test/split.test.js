const assert = require('assert');
const { PDFDocument, PDFName, rgb, StandardFonts } = require('pdf-lib');
const { splitPdfBytes, parsePageList, visualRectToBox } = require('../split-core');

async function makeFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([800, 600]);
    page.drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0.9, 1, 0.9) });
    page.drawText(`LEFT ${i + 1}`, { x: 40, y: 300, size: 40, font });
    page.drawText(`RIGHT ${i + 1}`, { x: 440, y: 300, size: 40, font });
    // bulk content so the size assertion below is meaningful
    for (let k = 0; k < 2000; k++) {
      page.drawRectangle({ x: k % 800, y: (k * 7) % 600, width: 3, height: 3, color: rgb(0.5, 0.5, 0.5) });
    }
  }
  const rotated = doc.addPage([800, 600]);
  rotated.setRotation({ type: 'degrees', angle: 90 });
  rotated.drawText('ROT', { x: 40, y: 300, size: 40, font });
  return doc.save();
}

function boxOf(page) {
  const { x, y, width, height } = page.getMediaBox();
  return [x, y, x + width, y + height].map((n) => Math.round(n * 100) / 100);
}

async function run() {
  const src = await makeFixture();

  // 1. plain half split
  let out = await PDFDocument.load(await splitPdfBytes(src, { split: 0.5 }));
  assert.strictEqual(out.getPageCount(), 8, 'four pages must become eight');
  assert.deepStrictEqual(boxOf(out.getPage(0)), [0, 0, 400, 600], 'left half');
  assert.deepStrictEqual(boxOf(out.getPage(1)), [400, 0, 800, 600], 'right half');

  // 2. /Rotate 90 is honoured: the visual left half is the lower part of the box
  assert.deepStrictEqual(boxOf(out.getPage(6)), [0, 0, 800, 300], 'rotated left half');
  assert.deepStrictEqual(boxOf(out.getPage(7)), [0, 300, 800, 600], 'rotated right half');
  assert.strictEqual(out.getPage(6).getRotation().angle, 90, 'rotation is preserved');

  // 3. off-centre split plus outer margins
  out = await PDFDocument.load(await splitPdfBytes(src, {
    split: 0.6,
    margins: { left: 0.05, right: 0.1, top: 0.02, bottom: 0.04 },
  }));
  assert.deepStrictEqual(boxOf(out.getPage(0)), [40, 24, 480, 588], 'cropped left half');
  assert.deepStrictEqual(boxOf(out.getPage(1)), [480, 24, 720, 588], 'cropped right half');

  // 4. skipped pages stay whole
  out = await PDFDocument.load(await splitPdfBytes(src, { split: 0.5, skip: [0] }));
  assert.strictEqual(out.getPageCount(), 7, 'skipped page is not doubled');
  assert.deepStrictEqual(boxOf(out.getPage(0)), [0, 0, 800, 600], 'skipped page keeps full box');
  assert.deepStrictEqual(boxOf(out.getPage(1)), [0, 0, 400, 600], 'next page still splits');

  // 5. both halves share one content stream, so the file must not double in size
  const bytes = await splitPdfBytes(src, { split: 0.5 });
  assert.ok(bytes.length < src.length * 1.15, `output grew too much: ${src.length} -> ${bytes.length}`);
  const reloaded = await PDFDocument.load(bytes);
  const contents = (p) => JSON.stringify(p.node.get(PDFName.of('Contents')));
  assert.strictEqual(contents(reloaded.getPage(0)), contents(reloaded.getPage(1)),
    'halves must reference the same content');

  // 6. page list parsing
  assert.deepStrictEqual(parsePageList('1, 3-5, 99', 10), [0, 2, 3, 4]);
  assert.deepStrictEqual(parsePageList('', 10), []);

  // 7. rotation mapping is self-consistent for all four angles
  const unit = { x: 0, y: 0, width: 100, height: 100 };
  [0, 90, 180, 270].forEach((angle) => {
    const r = visualRectToBox(unit, angle, { x0: 0, x1: 1, y0: 0, y1: 1 });
    assert.deepStrictEqual([r.llx, r.lly, r.urx, r.ury], [0, 0, 100, 100], `full rect at ${angle}`);
  });

  console.log('all assertions passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
