/*
 * Book Scan Splitter, https://github.com/it-stoic/book-scan-splitter
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 * If you host a modified version, its users must be offered its source.
 */
/*
 * Splits every page of a PDF into two halves by rewriting page boxes instead of
 * re-rendering: each half is a page dictionary that shares the original
 * /Contents and /Resources, so image data is never duplicated and the scan keeps
 * its exact quality.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SplitCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function lib() {
    if (typeof PDFLib !== 'undefined') return PDFLib;
    return require('pdf-lib');
  }

  function normalizeRotation(angle) {
    var a = angle % 360;
    if (a < 0) a += 360;
    return Math.round(a / 90) * 90 % 360;
  }

  function pageRotation(leaf) {
    var L = lib();
    var value = leaf.getInheritableAttribute(L.PDFName.of('Rotate')); // inheritable
    var number = value === undefined ? undefined : leaf.context.lookupMaybe(value, L.PDFNumber);
    return normalizeRotation(number ? number.asNumber() : 0);
  }

  /*
   * Maps a rectangle expressed in fractions of the *rendered* page (x from the
   * visually left edge, y from the visually top edge) onto PDF box coordinates,
   * undoing the rotation the viewer will apply.
   */
  function visualRectToBox(box, rotation, r) {
    var u0, u1, v0, v1; // u: box left->right, v: box bottom->top
    if (rotation === 0) {
      u0 = r.x0; u1 = r.x1; v0 = 1 - r.y1; v1 = 1 - r.y0;
    } else if (rotation === 90) {
      u0 = r.y0; u1 = r.y1; v0 = r.x0; v1 = r.x1;
    } else if (rotation === 180) {
      u0 = 1 - r.x1; u1 = 1 - r.x0; v0 = r.y0; v1 = r.y1;
    } else {
      u0 = 1 - r.y1; u1 = 1 - r.y0; v0 = 1 - r.x1; v1 = 1 - r.x0;
    }
    return {
      llx: box.x + u0 * box.width,
      lly: box.y + v0 * box.height,
      urx: box.x + u1 * box.width,
      ury: box.y + v1 * box.height,
    };
  }

  function halfRects(direction, split, m) {
    var left = m.left || 0, right = 1 - (m.right || 0);
    var top = m.top || 0, bottom = 1 - (m.bottom || 0);
    if (direction === 'horizontal') {
      return [
        { x0: left, x1: right, y0: top, y1: split },
        { x0: left, x1: right, y0: split, y1: bottom },
      ];
    }
    return [
      { x0: left, x1: split, y0: top, y1: bottom },
      { x0: split, x1: right, y0: top, y1: bottom },
    ];
  }

  function clonePageLeaf(doc, srcPage) {
    var L = lib();
    var leaf = srcPage.node;
    leaf.normalize(); // pushes inherited /Resources down onto the leaf
    var entries = new Map();
    leaf.entries().forEach(function (entry) {
      entries.set(entry[0], entry[1]);
    });
    var newLeaf = L.PDFPageLeaf.fromMapWithContext(entries, doc.context, false);
    return { leaf: newLeaf, ref: doc.context.register(newLeaf) };
  }

  function applyBox(context, leaf, rect, rotation) {
    var L = lib();
    var value = context.obj([rect.llx, rect.lly, rect.urx, rect.ury]);
    leaf.set(L.PDFName.of('MediaBox'), value);
    leaf.set(L.PDFName.of('CropBox'), context.obj([rect.llx, rect.lly, rect.urx, rect.ury]));
    leaf.set(L.PDFName.of('Rotate'), context.obj(rotation));
    ['BleedBox', 'TrimBox', 'ArtBox'].forEach(function (name) {
      leaf.delete(L.PDFName.of(name));
    });
  }

  function pagesInRange(range, pageCount) {
    var from = range && range.from ? Math.max(1, Math.round(range.from)) : 1;
    var to = range && range.to ? Math.min(pageCount, Math.round(range.to)) : pageCount;
    var out = [];
    for (var p = from; p <= to; p++) out.push(p - 1);
    return out;
  }

  async function keepOnly(doc, keep) {
    var L = lib();
    var out = await L.PDFDocument.create(); // unlinking alone would still write them out
    var copied = await out.copyPages(doc, keep);
    copied.forEach(function (page) { out.addPage(page); });
    return out;
  }

  /*
   * options: {
   *   direction: 'vertical' | 'horizontal',
   *   split, margins: { left, right, top, bottom },
   *   rotate: 0|90|180|270, rotateScope: 'all'|'odd'|'even',
   *   reverse: bool, range: { from, to } (1-based, inclusive), onProgress
   * }
   * All geometry is given as fractions of the rendered page, after `rotate`.
   */
  async function splitPdfBytes(bytes, options) {
    var L = lib();
    var opts = options || {};
    var direction = opts.direction === 'horizontal' ? 'horizontal' : 'vertical';
    var split = opts.split == null ? 0.5 : opts.split;
    var margins = opts.margins || {};
    var extraRotation = normalizeRotation(opts.rotate || 0);
    var rotateScope = opts.rotateScope || 'all';
    var reverse = !!opts.reverse;
    var onProgress = opts.onProgress;

    var doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true });
    var inputCount = doc.getPageCount();
    var keep = pagesInRange(opts.range, inputCount);
    if (!keep.length) throw new Error('The page range selects no pages.');
    if (keep.length !== inputCount) doc = await keepOnly(doc, keep);

    var context = doc.context;
    var pages = doc.getPages();
    var pagesRef = doc.catalog.get(L.PDFName.of('Pages'));
    if (!(pagesRef instanceof L.PDFRef)) {
      throw new Error('Unexpected PDF structure: /Pages is not an indirect reference.');
    }

    var rects = halfRects(direction, split, margins);
    var order = [];

    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var box = page.getCropBox();
      var inputNumber = keep[i] + 1; // odd/even follows the numbering the user sees
      var rotateThisPage = rotateScope === 'all'
        || (rotateScope === 'odd' && inputNumber % 2 === 1)
        || (rotateScope === 'even' && inputNumber % 2 === 0);
      var rotation = normalizeRotation(
        pageRotation(page.node) + (rotateThisPage ? extraRotation : 0)
      );

      var clone = clonePageLeaf(doc, page);
      applyBox(context, page.node, visualRectToBox(box, rotation, rects[0]), rotation);
      applyBox(context, clone.leaf, visualRectToBox(box, rotation, rects[1]), rotation);
      if (reverse) order.push(clone.ref, page.ref);
      else order.push(page.ref, clone.ref);

      if (onProgress) onProgress(i + 1, pages.length);
    }

    // Flatten the page tree so no inherited attribute of an intermediate node
    // is lost when the halves are re-ordered.
    order.forEach(function (ref) {
      context.lookup(ref).set(L.PDFName.of('Parent'), pagesRef);
    });
    var pagesDict = context.lookup(pagesRef);
    pagesDict.set(L.PDFName.of('Kids'), context.obj(order));
    pagesDict.set(L.PDFName.of('Count'), context.obj(order.length));

    return doc.save({ useObjectStreams: false });
  }

  return {
    splitPdfBytes: splitPdfBytes,
    pagesInRange: pagesInRange,
    halfRects: halfRects,
    visualRectToBox: visualRectToBox,
    normalizeRotation: normalizeRotation,
  };
});
