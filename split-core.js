/*
 * Splits every page of a PDF into a left and a right half by rewriting page
 * boxes instead of re-rendering: each half is a page dictionary that shares the
 * original /Contents and /Resources, so image data is never duplicated and the
 * scan keeps its exact quality.
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

  /*
   * Maps a rectangle expressed in fractions of the *rendered* page (x from the
   * visually left edge, y from the visually top edge) onto PDF box coordinates,
   * undoing the page's /Rotate.
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

  function applyBox(context, leaf, rect) {
    var L = lib();
    var value = context.obj([rect.llx, rect.lly, rect.urx, rect.ury]);
    leaf.set(L.PDFName.of('MediaBox'), value);
    leaf.set(L.PDFName.of('CropBox'), context.obj([rect.llx, rect.lly, rect.urx, rect.ury]));
    ['BleedBox', 'TrimBox', 'ArtBox'].forEach(function (name) {
      leaf.delete(L.PDFName.of(name));
    });
  }

  function parsePageList(text, pageCount) {
    var out = [];
    if (!text) return out;
    text.split(/[,;\s]+/).forEach(function (part) {
      if (!part) return;
      var range = part.split('-');
      var from = parseInt(range[0], 10);
      var to = range.length > 1 ? parseInt(range[1], 10) : from;
      if (isNaN(from) || isNaN(to)) return;
      if (to < from) { var t = from; from = to; to = t; }
      for (var p = from; p <= to; p++) {
        if (p >= 1 && p <= pageCount && out.indexOf(p - 1) === -1) out.push(p - 1);
      }
    });
    return out;
  }

  /*
   * options: { split, margins:{left,right,top,bottom}, skip:[0-based], onProgress }
   * All geometry is given as fractions of the rendered page.
   */
  async function splitPdfBytes(bytes, options) {
    var L = lib();
    var opts = options || {};
    var split = opts.split == null ? 0.5 : opts.split;
    var m = opts.margins || {};
    var mL = m.left || 0, mR = m.right || 0, mT = m.top || 0, mB = m.bottom || 0;
    var skip = opts.skip || [];
    var onProgress = opts.onProgress;

    var doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true });
    var context = doc.context;
    var pages = doc.getPages();

    var pagesRef = doc.catalog.get(L.PDFName.of('Pages'));
    if (!(pagesRef instanceof L.PDFRef)) {
      throw new Error('Unexpected PDF structure: /Pages is not an indirect reference.');
    }

    var order = [];
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var box = page.getCropBox();
      var rotation = normalizeRotation(page.getRotation().angle);
      var top = mT, bottom = 1 - mB;

      if (skip.indexOf(i) !== -1) {
        applyBox(context, page.node, visualRectToBox(box, rotation, {
          x0: mL, x1: 1 - mR, y0: top, y1: bottom,
        }));
        order.push(page.ref);
      } else {
        var clone = clonePageLeaf(doc, page);
        applyBox(context, page.node, visualRectToBox(box, rotation, {
          x0: mL, x1: split, y0: top, y1: bottom,
        }));
        applyBox(context, clone.leaf, visualRectToBox(box, rotation, {
          x0: split, x1: 1 - mR, y0: top, y1: bottom,
        }));
        order.push(page.ref, clone.ref);
      }
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
    parsePageList: parsePageList,
    visualRectToBox: visualRectToBox,
    normalizeRotation: normalizeRotation,
  };
});
