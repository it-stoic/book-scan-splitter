/*
 * Book Scan Splitter, https://github.com/it-stoic/book-scan-splitter
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 * If you host a modified version, its users must be offered its source.
 */
(function () {
  'use strict';

  var PREVIEW_WIDTH = 880;   // CSS pixels the preview is composited at
  var VIEW_MIN_HEIGHT = 260; // shortest the preview is ever shown
  var MAX_SAMPLES = 16;      // pages composited in overlay mode
  var GRAB = 11;             // hit radius in screen pixels
  var RESULT_PAGES = 10;     // output pages shown by "Preview result"
  var SKEW_WIDTH = 700;      // pixels a page is rendered at to measure its skew

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  var el = function (id) { return document.getElementById(id); };
  var ui = {
    drop: el('drop'), file: el('file'), pick: el('pick'), change: el('change'),
    workspace: el('workspace'), fileName: el('fileName'), fileMeta: el('fileMeta'),
    modeTabs: el('modeTabs'), pager: el('pager'), prev: el('prev'), next: el('next'),
    pageNum: el('pageNum'), pageTotal: el('pageTotal'), renderInfo: el('renderInfo'),
    hint: el('hint'), preview: el('preview'),
    directionTabs: el('directionTabs'), detect: el('detect'), detectInfo: el('detectInfo'),
    splitRange: el('splitRange'), splitPct: el('splitPct'), resetGeom: el('resetGeom'),
    rotLeft: el('rotLeft'), rotRight: el('rotRight'), rotInfo: el('rotInfo'),
    rotScope: el('rotScope'), rangeFrom: el('rangeFrom'), rangeTo: el('rangeTo'),
    reverse: el('reverse'), reverseLabel: el('reverseLabel'), deskew: el('deskew'),
    deskewInfo: el('deskewInfo'),
    go: el('go'), check: el('check'), status: el('status'), install: el('install'),
    cleanNext: el('cleanNext'),
    resultDialog: el('resultDialog'), resultGrid: el('resultGrid'),
    resultInfo: el('resultInfo'), resultClose: el('resultClose'),
    margin: {
      left: el('mLeft'), right: el('mRight'), top: el('mTop'), bottom: el('mBottom'),
    },
  };

  var state = {
    file: null, pdf: null, pageCount: 0,
    direction: 'vertical',
    split: 0.5,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
    rotate: 0,
    rotateScope: 'all',
    reverse: false,
    deskew: false,
    mode: 'overlay',
    page: 1,
    token: 0,
    base: null,
    view: { w: PREVIEW_WIDTH, h: 600, dpr: 1 },
    aspect: 1.4,
    drag: null,
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function pct(v) { return (Math.round(v * 1000) / 10) + ' %'; }
  function status(text) { ui.status.textContent = text || ''; }
  function isVertical() { return state.direction === 'vertical'; }

  function effectiveRange() {
    var from = clamp(parseInt(ui.rangeFrom.value, 10) || 1, 1, state.pageCount || 1);
    var to = clamp(parseInt(ui.rangeTo.value, 10) || state.pageCount, 1, state.pageCount || 1);
    if (to < from) { var t = from; from = to; to = t; }
    return { from: from, to: to };
  }

  function rotationFor(pageNumber) {
    if (!state.rotate) return 0;
    if (state.rotateScope === 'odd' && pageNumber % 2 === 0) return 0;
    if (state.rotateScope === 'even' && pageNumber % 2 === 1) return 0;
    return state.rotate;
  }

  function splitOptions(range) {
    return {
      direction: state.direction,
      split: state.split,
      margins: state.margins,
      rotate: state.rotate,
      rotateScope: state.rotateScope,
      reverse: state.reverse,
      range: range,
    };
  }

  /* ---------------------------------------------------------------- loading */

  function openFile(file) {
    if (!file) return;
    state.file = file;
    state.pdf = null;
    state.base = null;
    state.page = 1;
    ui.fileName.textContent = file.name;
    ui.fileMeta.textContent = file.size > 1048576
      ? (file.size / 1048576).toFixed(1) + ' MB'
      : Math.round(file.size / 1024) + ' kB';
    ui.drop.hidden = true;
    ui.workspace.hidden = false;
    status('');
    ui.cleanNext.hidden = true;
    ui.detectInfo.textContent = '';
    file.arrayBuffer().then(function (buf) {
      // pdf.js may detach the buffer it is given, so hand it a private copy
      return pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    }).then(function (pdf) {
      state.pdf = pdf;
      state.pageCount = pdf.numPages;
      ui.pageTotal.textContent = '/ ' + pdf.numPages;
      ui.pageNum.max = pdf.numPages;
      ui.pageNum.value = 1;
      ui.rangeFrom.max = pdf.numPages;
      ui.rangeTo.max = pdf.numPages;
      ui.rangeFrom.value = '';
      ui.rangeTo.value = '';
      ui.go.disabled = false;
      renderPreview();
    }).catch(function (err) {
      status('Cannot open PDF: ' + err.message);
    });
  }

  ui.pick.addEventListener('click', function () { ui.file.click(); });
  ui.change.addEventListener('click', function () { ui.file.click(); });
  ui.file.addEventListener('change', function () { openFile(ui.file.files[0]); });

  ['dragenter', 'dragover'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      e.preventDefault();
      ui.drop.classList.add('over');
    });
  });
  window.addEventListener('dragleave', function (e) {
    if (e.relatedTarget === null) ui.drop.classList.remove('over');
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    ui.drop.classList.remove('over');
    openFile(e.dataTransfer.files[0]);
  });

  /* --------------------------------------------------------------- preview */

  function samplePages() {
    var r = effectiveRange();
    var n = r.to - r.from + 1;
    var out = [];
    if (n <= MAX_SAMPLES) {
      for (var i = r.from; i <= r.to; i++) out.push(i);
      return out;
    }
    for (var k = 0; k < MAX_SAMPLES; k++) {
      out.push(r.from + Math.round(k * (n - 1) / (MAX_SAMPLES - 1)));
    }
    return out;
  }

  function renderPageToCanvas(page, pxWidth, extraRotation) {
    var rotation = (page.rotate + (extraRotation || 0)) % 360;
    var scale = pxWidth / page.getViewport({ scale: 1, rotation: rotation }).width;
    var viewport = page.getViewport({ scale: scale, rotation: rotation });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
      return canvas;
    });
  }

  async function renderPreview() {
    if (!state.pdf) return;
    var token = ++state.token;
    var pdf = state.pdf;
    var numbers = state.mode === 'single' ? [state.page] : samplePages();

    // a cover page can have a different shape than the spreads, so take the
    // proportions from a page in the middle of the sample
    var middle = numbers[Math.floor(numbers.length / 2)];
    var first = await pdf.getPage(middle);
    if (token !== state.token) return;
    var vp = first.getViewport({ scale: 1, rotation: (first.rotate + rotationFor(middle)) % 360 });
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = PREVIEW_WIDTH;
    var h = Math.round(w * vp.height / vp.width);
    state.aspect = vp.height / vp.width;
    state.view.dpr = dpr;
    fitView();

    // the composite is kept at full width however small the view of it is, so
    // the edge detection reads the same pixels on a phone as on a desktop
    var base = document.createElement('canvas');
    base.width = Math.round(w * dpr);
    base.height = Math.round(h * dpr);
    var bctx = base.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.fillStyle = '#fff';
    bctx.fillRect(0, 0, w, h);
    state.base = base;
    drawStage();

    for (var i = 0; i < numbers.length; i++) {
      var page = await pdf.getPage(numbers[i]);
      if (token !== state.token) return;
      var rendered = await renderPageToCanvas(page, w * dpr, rotationFor(numbers[i]));
      if (token !== state.token) return;
      page.cleanup();
      // "darken" keeps the darkest pixel of every page, so the composite shows
      // the union of all text and the gutter across the whole book
      bctx.globalCompositeOperation = i === 0 ? 'source-over' : 'darken';
      bctx.drawImage(rendered, 0, 0, w, h);
      ui.renderInfo.textContent = state.mode === 'single'
        ? 'page ' + numbers[0]
        : 'overlay of ' + (i + 1) + '/' + numbers.length + ' pages';
      drawStage();
      await new Promise(function (r) { setTimeout(r, 0); });
    }
  }

  /* -------------------------------------------------------------- drawing */

  function bounds() {
    var m = state.margins;
    return { left: m.left, right: 1 - m.right, top: m.top, bottom: 1 - m.bottom };
  }

  function splitLimits() {
    var b = bounds();
    return isVertical() ? { lo: b.left, hi: b.right } : { lo: b.top, hi: b.bottom };
  }

  /*
   * The page is shown at whatever is left of the screen below the header, rather
   * than at full width: a tall spread drawn 880 pixels across runs several
   * screens down on a phone, and puts the controls out of sight on a desktop.
   */
  function fitView() {
    var stage = ui.preview.parentElement;
    var pad = parseFloat(getComputedStyle(stage).paddingLeft) || 0;
    var room = Math.max(200, stage.clientWidth - pad * 2);
    var v = state.view;
    var w = Math.min(PREVIEW_WIDTH, room);
    var h = w * state.aspect;
    var free = window.innerHeight - stage.getBoundingClientRect().top - window.scrollY;
    var roof = Math.max(VIEW_MIN_HEIGHT, free - pad * 2 - 24);
    if (h > roof) { h = roof; w = h / state.aspect; }
    v.w = Math.round(w);
    v.h = Math.round(h);
    ui.preview.width = Math.round(v.w * v.dpr);
    ui.preview.height = Math.round(v.h * v.dpr);
    ui.preview.style.width = v.w + 'px';
    ui.preview.style.height = v.h + 'px';
  }

  var fitTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(function () {
      if (!state.base) return;
      fitView();
      drawStage();
    }, 120);
  });

  function drawStage() {
    var v = state.view;
    var ctx = ui.preview.getContext('2d');
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.clearRect(0, 0, v.w, v.h);
    if (state.base) ctx.drawImage(state.base, 0, 0, v.w, v.h);

    var b = bounds();
    var L = b.left * v.w, R = b.right * v.w, T = b.top * v.h, B = b.bottom * v.h;
    var lim = splitLimits();
    var s = clamp(state.split, lim.lo, lim.hi);

    ctx.fillStyle = 'rgba(90, 100, 112, .55)';
    ctx.fillRect(0, 0, v.w, T);
    ctx.fillRect(0, B, v.w, v.h - B);
    ctx.fillRect(0, T, L, B - T);
    ctx.fillRect(R, T, v.w - R, B - T);

    var first = 'rgba(15, 157, 120, .18)';
    var second = 'rgba(58, 110, 220, .18)';
    var x1, y1, x2, y2, hx, hy;
    if (isVertical()) {
      var S = s * v.w;
      ctx.fillStyle = first; ctx.fillRect(L, T, S - L, B - T);
      ctx.fillStyle = second; ctx.fillRect(S, T, R - S, B - T);
      x1 = S; y1 = T; x2 = S; y2 = B;
      hx = S; hy = (T + B) / 2;
    } else {
      var Sy = s * v.h;
      ctx.fillStyle = first; ctx.fillRect(L, T, R - L, Sy - T);
      ctx.fillStyle = second; ctx.fillRect(L, Sy, R - L, B - Sy);
      x1 = L; y1 = Sy; x2 = R; y2 = Sy;
      hx = (L + R) / 2; hy = Sy;
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, .9)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    line(ctx, L, T, L, B); line(ctx, R, T, R, B);
    line(ctx, L, T, R, T); line(ctx, L, B, R, B);
    ctx.setLineDash([]);

    ctx.strokeStyle = '#0f9d78';
    ctx.lineWidth = 2.5;
    line(ctx, x1, y1, x2, y2);
    ctx.fillStyle = '#0f9d78';
    ctx.beginPath();
    ctx.arc(hx, hy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    if (isVertical()) {
      ctx.fillRect(hx - 3.5, hy - 3, 1.5, 6);
      ctx.fillRect(hx + 2, hy - 3, 1.5, 6);
    } else {
      ctx.fillRect(hx - 3, hy - 3.5, 6, 1.5);
      ctx.fillRect(hx - 3, hy + 2, 6, 1.5);
    }

    var label = pct(state.split);
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    var lw = ctx.measureText(label).width + 14;
    var lx = isVertical() ? x1 : Math.min(L + lw / 2 + 6, v.w - lw / 2);
    var ly = isVertical() ? Math.min(T + 8, v.h - 26) : clamp(y1 - 22, 2, v.h - 20);
    ctx.fillStyle = '#0f9d78';
    ctx.fillRect(lx - lw / 2, ly, lw, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx, ly + 13);
  }

  function line(ctx, x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  /* ------------------------------------------------------------ dragging */

  function handles() {
    var b = bounds();
    return [
      { key: 'split', axis: isVertical() ? 'x' : 'y', at: state.split },
      { key: 'left', axis: 'x', at: b.left },
      { key: 'right', axis: 'x', at: b.right },
      { key: 'top', axis: 'y', at: b.top },
      { key: 'bottom', axis: 'y', at: b.bottom },
    ];
  }

  function pointerFractions(e) {
    var r = ui.preview.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
      tolX: GRAB / r.width,
      tolY: GRAB / r.height,
    };
  }

  function nearestHandle(p) {
    var best = null, bestDist = Infinity;
    handles().forEach(function (h) {
      var d = h.axis === 'x' ? Math.abs(p.x - h.at) / p.tolX : Math.abs(p.y - h.at) / p.tolY;
      if (d <= 1 && d < bestDist) { best = h; bestDist = d; }
    });
    return best;
  }

  function applyHandle(key, p) {
    var m = state.margins;
    if (key === 'split') {
      setSplit(isVertical() ? p.x : p.y);
    } else if (key === 'left') {
      m.left = clamp(p.x, 0, 0.45);
      setSplit(state.split);
    } else if (key === 'right') {
      m.right = clamp(1 - p.x, 0, 0.45);
      setSplit(state.split);
    } else if (key === 'top') {
      m.top = clamp(p.y, 0, 0.45);
      setSplit(state.split);
    } else if (key === 'bottom') {
      m.bottom = clamp(1 - p.y, 0, 0.45);
      setSplit(state.split);
    }
    syncInputs();
    drawStage();
  }

  ui.preview.addEventListener('pointerdown', function (e) {
    var p = pointerFractions(e);
    var h = nearestHandle(p);
    if (!h) return;
    state.drag = h.key;
    ui.preview.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  ui.preview.addEventListener('pointermove', function (e) {
    var p = pointerFractions(e);
    if (state.drag) {
      applyHandle(state.drag, p);
      return;
    }
    var h = nearestHandle(p);
    ui.preview.style.cursor = h ? (h.axis === 'x' ? 'col-resize' : 'row-resize') : 'default';
  });

  ['pointerup', 'pointercancel'].forEach(function (type) {
    ui.preview.addEventListener(type, function () { state.drag = null; });
  });

  /* ------------------------------------------------------- auto detection */

  function luminanceProfiles(px, w, h, x0, x1, y0, y1, dark) {
    var cols = new Float64Array(w), rows = new Float64Array(h);
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var i = (y * w + x) * 4;
        var lum = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
        var value = dark ? (lum < 140 ? 1 : 0) : lum;
        cols[x] += value;
        rows[y] += value;
      }
    }
    return { cols: cols, rows: rows };
  }

  function contentSpan(sums, from, to, count) {
    var max = 0, i;
    for (i = from; i < to; i++) max = Math.max(max, sums[i] / count);
    if (max <= 0) return [from, to];
    var limit = max * 0.55;
    var lo = from, hi = to - 1;
    while (lo < hi && sums[lo] / count < limit) lo++;
    while (hi > lo && sums[hi] / count < limit) hi--;
    return [lo, hi + 1];
  }

  function median(values) {
    var sorted = values.slice().sort(function (x, y) { return x - y; });
    return sorted[sorted.length >> 1];
  }

  function findGutter(ink, lo, hi, count) {
    var span = hi - lo;
    var a = Math.round(lo + span * 0.3), b = Math.round(lo + span * 0.7);
    var peak = 0, peakAt = (a + b) / 2, band = [], i;
    for (i = a; i < b; i++) {
      var f = ink[i] / count;
      band.push(f);
      if (f > peak) { peak = f; peakAt = i; }
    }
    // the binding casts a narrow dark band; a page that is dark all over is text
    if (peak > 0.5 && peak > median(band) * 2) return peakAt;

    var bestStart = -1, bestLen = 0, runStart = -1;
    for (i = a; i < b; i++) {
      if (ink[i] / count < 0.02) {
        if (runStart < 0) runStart = i;
        if (i - runStart + 1 > bestLen) { bestLen = i - runStart + 1; bestStart = runStart; }
      } else {
        runStart = -1;
      }
    }
    return bestLen > 0 ? bestStart + bestLen / 2 : (a + b) / 2;
  }

  function detectGeometry() {
    if (!state.base) return false;
    var w = state.base.width, h = state.base.height;
    var px = state.base.getContext('2d').getImageData(0, 0, w, h).data;

    var light = luminanceProfiles(px, w, h, 0, w, 0, h, false);
    var xs = contentSpan(light.cols, 0, w, h);
    var ys = contentSpan(light.rows, 0, h, w);
    if (xs[1] - xs[0] < w * 0.3 || ys[1] - ys[0] < h * 0.3) return false;

    var ink = luminanceProfiles(px, w, h, xs[0], xs[1], ys[0], ys[1], true);
    var cut = isVertical()
      ? findGutter(ink.cols, xs[0], xs[1], ys[1] - ys[0]) / w
      : findGutter(ink.rows, ys[0], ys[1], xs[1] - xs[0]) / h;

    state.margins = {
      left: clamp(xs[0] / w, 0, 0.45),
      right: clamp(1 - xs[1] / w, 0, 0.45),
      top: clamp(ys[0] / h, 0, 0.45),
      bottom: clamp(1 - ys[1] / h, 0, 0.45),
    };
    setSplit(cut);
    syncInputs();
    drawStage();
    return true;
  }

  ui.detect.addEventListener('click', function () {
    ui.detectInfo.textContent = detectGeometry()
      ? 'cut at ' + pct(state.split) + ' — check it before saving'
      : 'nothing clear enough to measure; set it by hand';
  });

  /* ------------------------------------------------------------- controls */

  function setSplit(value) {
    var lim = splitLimits();
    state.split = clamp(value, lim.lo + 0.01, lim.hi - 0.01);
  }

  function syncInputs() {
    ui.splitRange.value = (state.split * 100).toFixed(1);
    ui.splitPct.value = (state.split * 100).toFixed(1);
    Object.keys(ui.margin).forEach(function (k) {
      ui.margin[k].value = (state.margins[k] * 100).toFixed(1);
    });
    ui.rotInfo.textContent = state.rotate + '°';
    ui.reverseLabel.textContent = isVertical()
      ? 'Right-to-left book (right half first)'
      : 'Bottom half first';
    ui.hint.textContent = isVertical()
      ? 'Drag the vertical line to set where the cut goes, and the edge lines to trim the scanner borders.'
      : 'Drag the horizontal line to set where the cut goes, and the edge lines to trim the scanner borders.';
  }

  ui.splitRange.addEventListener('input', function () {
    setSplit(parseFloat(ui.splitRange.value) / 100);
    syncInputs();
    drawStage();
  });
  ui.splitPct.addEventListener('change', function () {
    setSplit(parseFloat(ui.splitPct.value) / 100 || 0.5);
    syncInputs();
    drawStage();
  });

  Object.keys(ui.margin).forEach(function (key) {
    ui.margin[key].addEventListener('change', function () {
      state.margins[key] = clamp((parseFloat(ui.margin[key].value) || 0) / 100, 0, 0.45);
      setSplit(state.split);
      syncInputs();
      drawStage();
    });
  });

  ui.resetGeom.addEventListener('click', function () {
    state.margins = { left: 0, right: 0, top: 0, bottom: 0 };
    state.split = 0.5;
    syncInputs();
    drawStage();
  });

  function setDirection(direction) {
    state.direction = direction;
    Array.prototype.forEach.call(ui.directionTabs.children, function (b) {
      b.classList.toggle('on', b.dataset.direction === direction);
    });
    setSplit(state.split);
    syncInputs();
    drawStage();
  }

  Array.prototype.forEach.call(ui.directionTabs.children, function (button) {
    button.addEventListener('click', function () {
      setDirection(button.dataset.direction);
    });
  });

  function rotateView(delta) {
    var m = state.margins;
    state.rotate = (state.rotate + delta + 360) % 360;
    // turn the geometry with the view, so the cut stays on the same paper edge
    if (state.rotateScope === 'all') {
      if (delta === 90) {
        state.margins = { left: m.bottom, top: m.left, right: m.top, bottom: m.right };
      } else {
        state.margins = { left: m.top, top: m.right, right: m.bottom, bottom: m.left };
        state.split = 1 - state.split;
      }
      setDirection(isVertical() ? 'horizontal' : 'vertical');
    }
    syncInputs();
    renderPreview();
  }

  ui.rotLeft.addEventListener('click', function () { rotateView(-90); });
  ui.rotRight.addEventListener('click', function () { rotateView(90); });
  ui.rotScope.addEventListener('change', function () {
    state.rotateScope = ui.rotScope.value;
    renderPreview();
  });

  [ui.rangeFrom, ui.rangeTo].forEach(function (input) {
    input.addEventListener('change', function () { renderPreview(); });
  });
  ui.reverse.addEventListener('change', function () { state.reverse = ui.reverse.checked; });
  ui.deskew.addEventListener('change', function () {
    state.deskew = ui.deskew.checked;
    ui.deskewInfo.hidden = !state.deskew;
  });

  Array.prototype.forEach.call(ui.modeTabs.children, function (button) {
    button.addEventListener('click', function () {
      state.mode = button.dataset.mode;
      Array.prototype.forEach.call(ui.modeTabs.children, function (b) {
        b.classList.toggle('on', b === button);
      });
      ui.pager.hidden = state.mode !== 'single';
      renderPreview();
    });
  });

  function goToPage(n) {
    state.page = clamp(n, 1, state.pageCount);
    ui.pageNum.value = state.page;
    renderPreview();
  }
  ui.prev.addEventListener('click', function () { goToPage(state.page - 1); });
  ui.next.addEventListener('click', function () { goToPage(state.page + 1); });
  ui.pageNum.addEventListener('change', function () {
    goToPage(parseInt(ui.pageNum.value, 10) || 1);
  });

  window.addEventListener('keydown', function (e) {
    if (document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    var back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    var forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    if (!back && !forward) return;
    setSplit(state.split + (e.shiftKey ? 0.01 : 0.001) * (back ? -1 : 1));
    syncInputs();
    drawStage();
    e.preventDefault();
  });


  /* ------------------------------------------------------------- deskew */

  function toGray(image) {
    var d = image.data, gray = new Uint8Array(image.width * image.height);
    for (var i = 0, p = 0; p < gray.length; i += 4, p++) {
      gray[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    }
    return gray;
  }

  async function straighten(bytes) {
    var pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    var angles = [], turned = 0;
    for (var i = 1; i <= pdf.numPages; i++) {
      var page = await pdf.getPage(i);
      var canvas = await renderPageToCanvas(page, SKEW_WIDTH, 0);
      page.cleanup();
      var image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      var angle = DeskewCore.measureSkew(toGray(image), canvas.width, canvas.height);
      angles.push(angle);
      if (angle) turned++;
      status('Measuring page ' + i + ' of ' + pdf.numPages + '…');
      // the render loop needs the main thread back now and then
      if (i % 5 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    pdf.destroy();
    var largest = angles.reduce(function (m, a) { return Math.max(m, Math.abs(a)); }, 0);
    return {
      bytes: await DeskewCore.deskewPdfBytes(bytes, angles),
      note: turned
        ? ' Straightened ' + turned + ' of ' + angles.length + ' pages, up to ' + largest.toFixed(1) + '°.'
        : ' No page looked crooked enough to straighten.',
    };
  }

  /* ---------------------------------------------------------------- split */

  ui.go.addEventListener('click', async function () {
    if (!state.file) return;
    ui.go.disabled = true;
    status('Working…');
    await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
    try {
      var range = effectiveRange();
      var bytes = new Uint8Array(await state.file.arrayBuffer());
      var out = await SplitCore.splitPdfBytes(bytes, splitOptions(range));
      var note = '';
      if (state.deskew) {
        var straightened = await straighten(out);
        out = straightened.bytes;
        note = straightened.note;
      }
      var count = range.to - range.from + 1;
      save(out, state.file.name.replace(/\.pdf$/i, '') + '-split.pdf');
      status('Done: ' + count + ' → ' + count * 2 + ' pages.' + note);
      ui.cleanNext.hidden = false;
    } catch (err) {
      status('Error: ' + err.message);
    }
    ui.go.disabled = false;
  });

  ui.check.addEventListener('click', async function () {
    if (!state.file) return;
    ui.check.disabled = true;
    status('Building preview…');
    try {
      var range = effectiveRange();
      var to = Math.min(range.to, range.from + Math.ceil(RESULT_PAGES / 2) - 1);
      var bytes = new Uint8Array(await state.file.arrayBuffer());
      var out = await SplitCore.splitPdfBytes(bytes, splitOptions({ from: range.from, to: to }));
      if (state.deskew) out = (await straighten(out)).bytes;
      await showResult(out, range);
      status('');
    } catch (err) {
      status('Error: ' + err.message);
    }
    ui.check.disabled = false;
  });

  async function showResult(bytes, range) {
    var pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    var shown = Math.min(pdf.numPages, RESULT_PAGES);
    ui.resultGrid.textContent = '';
    ui.resultInfo.textContent = 'input pages ' + range.from + '–' + range.to
      + ', showing the first ' + shown;
    ui.resultDialog.showModal();
    for (var i = 1; i <= shown; i++) {
      var page = await pdf.getPage(i);
      var canvas = await renderPageToCanvas(page, 320, 0);
      page.cleanup();
      var cell = document.createElement('figure');
      var caption = document.createElement('figcaption');
      caption.textContent = i;
      cell.appendChild(canvas);
      cell.appendChild(caption);
      ui.resultGrid.appendChild(cell);
    }
    pdf.destroy();
  }

  ui.resultClose.addEventListener('click', function () { ui.resultDialog.close(); });
  ui.resultDialog.addEventListener('close', function () { ui.resultGrid.textContent = ''; });

  function save(bytes, name) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    // removing the anchor right away cancels the download in some browsers
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 30000);
  }

  /* ------------------------------------------------------- install / offline */

  // Only over http(s): a service worker cannot be registered from file://
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {
        // offline support is a bonus; the app works without it
      });
    });
  }

  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installPrompt = e;
    ui.install.hidden = false;
  });
  ui.install.addEventListener('click', function () {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt = null;
    ui.install.hidden = true;
  });
  window.addEventListener('appinstalled', function () { ui.install.hidden = true; });

  syncInputs();
})();
