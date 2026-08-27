/*
 * Book Scan Splitter, https://github.com/it-stoic/book-scan-splitter
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 * If you host a modified version, its users must be offered its source.
 */
/*
 * Straightens pages that were scanned a little crooked.
 *
 * The angle is measured the way every deskew tool measures it: rotate the ink
 * of a page through a range of candidate angles and keep the one whose
 * horizontal projection profile is sharpest. Straight text lines pile up into
 * tall spikes, crooked ones smear across many rows.
 *
 * The correction is then applied without touching a single pixel. The page
 * keeps its /Contents, wrapped in a two-tiny-stream sandwich that rotates the
 * whole thing about the centre of the crop box, so the scan is still the
 * original compressed bytes and the two halves of a spread still share one copy
 * of the image.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeskewCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMIT = 6;            // degrees searched either side of straight
  var COARSE = 0.5;
  var FINE = 0.05;
  var MAX_POINTS = 30000;
  var INSET = 0.04;         // ignored border, where a scanner leaves its edge
  var MIN_INK = 0.002;      // below this a page has nothing to measure
  var MIN_CONFIDENCE = 0.02;

  function lib() {
    if (typeof PDFLib !== 'undefined') return PDFLib;
    return require('pdf-lib');
  }

  function otsuThreshold(gray) {
    var hist = new Float64Array(256), i;
    for (i = 0; i < gray.length; i++) hist[gray[i]]++;
    var total = gray.length, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, weightB = 0, best = -1, threshold = 128;
    for (i = 0; i < 256; i++) {
      weightB += hist[i];
      if (weightB === 0) continue;
      var weightF = total - weightB;
      if (weightF === 0) break;
      sumB += i * hist[i];
      var meanB = sumB / weightB;
      var meanF = (sum - sumB) / weightF;
      var between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
      if (between > best) { best = between; threshold = i; }
    }
    return threshold;
  }

  function inkPoints(gray, w, h) {
    var threshold = otsuThreshold(gray);
    var x0 = Math.floor(w * INSET), x1 = w - x0;
    var y0 = Math.floor(h * INSET), y1 = h - y0;
    var found = [], x, y;
    for (y = y0; y < y1; y++) {
      for (x = x0; x < x1; x++) {
        if (gray[y * w + x] <= threshold) found.push(x, y);
      }
    }
    var count = found.length / 2;
    if (count < (x1 - x0) * (y1 - y0) * MIN_INK) return null;
    if (count <= MAX_POINTS) return found;
    var stride = Math.ceil(count / MAX_POINTS);
    var thinned = [];
    for (var i = 0; i < count; i += stride) thinned.push(found[i * 2], found[i * 2 + 1]);
    return thinned;
  }

  function profileScore(points, angle, cx, cy, bins, pad) {
    var sin = Math.sin(angle), cos = Math.cos(angle), i;
    bins.fill(0);
    for (i = 0; i < points.length; i += 2) {
      var row = cy + (points[i] - cx) * sin + (points[i + 1] - cy) * cos;
      bins[(row + pad) | 0]++;
    }
    var score = 0;
    for (i = 0; i < bins.length; i++) score += bins[i] * bins[i];
    return score;
  }

  function median(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[sorted.length >> 1];
  }

  /*
   * Returns the rotation that straightens the page, in degrees, counter-clockwise
   * positive in PDF user space. 0 means nothing worth measuring was found.
   */
  function measureSkew(gray, w, h) {
    var points = inkPoints(gray, w, h);
    if (!points) return 0;

    var cx = w / 2, cy = h / 2;
    var pad = Math.ceil(w * Math.sin(LIMIT * Math.PI / 180)) + 2;
    var bins = new Int32Array(h + 2 * pad + 2);
    var scores = [], angles = [], best = -1, bestAngle = 0, a;

    for (a = -LIMIT; a <= LIMIT + 1e-9; a += COARSE) {
      var score = profileScore(points, a * Math.PI / 180, cx, cy, bins, pad);
      scores.push(score);
      angles.push(a);
      if (score > best) { best = score; bestAngle = a; }
    }

    var middle = median(scores);
    if (!middle || (best - middle) / middle < MIN_CONFIDENCE) return 0;

    var from = bestAngle - COARSE, to = bestAngle + COARSE;
    for (a = from; a <= to + 1e-9; a += FINE) {
      var fine = profileScore(points, a * Math.PI / 180, cx, cy, bins, pad);
      if (fine > best) { best = fine; bestAngle = a; }
    }

    // image rows run down, PDF coordinates run up
    var corrected = -Math.round(bestAngle * 100) / 100;
    return corrected === 0 ? 0 : corrected;
  }

  function contentRefs(context, leaf, name) {
    var L = lib();
    var entry = leaf.get(name);
    if (!entry) return null;
    var resolved = context.lookup(entry);
    if (!(resolved instanceof L.PDFArray)) return [entry];
    var refs = [];
    for (var i = 0; i < resolved.size(); i++) refs.push(resolved.get(i));
    return refs.length ? refs : null;
  }

  function rotationMatrix(degrees, cx, cy) {
    var a = degrees * Math.PI / 180;
    var cos = Math.cos(a), sin = Math.sin(a);
    return [
      cos, sin, -sin, cos,
      cx - cx * cos + cy * sin,
      cy - cx * sin - cy * cos,
    ];
  }

  // angles[i] is the correction for output page i; a falsy one leaves it alone
  async function deskewPdfBytes(bytes, angles, onProgress) {
    var L = lib();
    var doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true });
    var context = doc.context;
    var contents = L.PDFName.of('Contents');
    var pages = doc.getPages();

    for (var i = 0; i < pages.length; i++) {
      var angle = angles[i];
      if (angle) {
        var leaf = pages[i].node;
        var refs = contentRefs(context, leaf, contents);
        if (refs) {
          var box = pages[i].getCropBox();
          var matrix = rotationMatrix(angle, box.x + box.width / 2, box.y + box.height / 2);
          var open = context.register(context.contentStream([
            L.PDFOperator.of('q'),
            L.PDFOperator.of('cm', matrix.map(function (n) { return L.PDFNumber.of(n); })),
          ]));
          var close = context.getPopGraphicsStateContentStream(); // identical for every page
          leaf.set(contents, context.obj([open].concat(refs).concat([close])));
        }
      }
      if (onProgress) onProgress(i + 1, pages.length);
    }

    return doc.save({ useObjectStreams: false });
  }

  return {
    measureSkew: measureSkew,
    deskewPdfBytes: deskewPdfBytes,
    otsuThreshold: otsuThreshold,
  };
});
