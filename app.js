(function () {
  'use strict';

  var PREVIEW_WIDTH = 880;   // CSS pixels of the preview canvas
  var MAX_SAMPLES = 16;      // pages composited in "preslika" mode
  var GRAB = 11;             // hit radius in screen pixels

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  var el = function (id) { return document.getElementById(id); };
  var ui = {
    drop: el('drop'), file: el('file'), pick: el('pick'), change: el('change'),
    workspace: el('workspace'), fileName: el('fileName'), fileMeta: el('fileMeta'),
    modeTabs: el('modeTabs'), pager: el('pager'), prev: el('prev'), next: el('next'),
    pageNum: el('pageNum'), pageTotal: el('pageTotal'), renderInfo: el('renderInfo'),
    preview: el('preview'), splitRange: el('splitRange'), splitPct: el('splitPct'),
    skip: el('skip'), go: el('go'), status: el('status'), resetGeom: el('resetGeom'),
    install: el('install'),
    margin: {
      left: el('mLeft'), right: el('mRight'), top: el('mTop'), bottom: el('mBottom'),
    },
  };

  var state = {
    file: null, pdf: null, pageCount: 0,
    split: 0.5,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
    mode: 'overlay',
    page: 1,
    token: 0,
    base: null,
    view: { w: PREVIEW_WIDTH, h: 600, dpr: 1 },
    drag: null,
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function pct(v) { return (Math.round(v * 1000) / 10) + ' %'; }
  function status(text) { ui.status.textContent = text || ''; }

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
    file.arrayBuffer().then(function (buf) {
      // pdf.js may detach the buffer it is given, so hand it a private copy
      return pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    }).then(function (pdf) {
      state.pdf = pdf;
      state.pageCount = pdf.numPages;
      ui.pageTotal.textContent = '/ ' + pdf.numPages;
      ui.pageNum.max = pdf.numPages;
      ui.pageNum.value = 1;
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
    var n = state.pageCount;
    if (n <= MAX_SAMPLES) {
      var all = [];
      for (var i = 1; i <= n; i++) all.push(i);
      return all;
    }
    var out = [];
    for (var k = 0; k < MAX_SAMPLES; k++) {
      out.push(1 + Math.round(k * (n - 1) / (MAX_SAMPLES - 1)));
    }
    return out;
  }

  function renderPageToCanvas(page, pxWidth) {
    var scale = pxWidth / page.getViewport({ scale: 1 }).width;
    var viewport = page.getViewport({ scale: scale });
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
    var first = await pdf.getPage(numbers[Math.floor(numbers.length / 2)]);
    if (token !== state.token) return;
    var vp = first.getViewport({ scale: 1 });
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = PREVIEW_WIDTH;
    var h = Math.round(w * vp.height / vp.width);
    state.view = { w: w, h: h, dpr: dpr };

    ui.preview.width = Math.round(w * dpr);
    ui.preview.height = Math.round(h * dpr);
    ui.preview.style.width = w + 'px';
    ui.preview.style.height = h + 'px';

    var base = document.createElement('canvas');
    base.width = ui.preview.width;
    base.height = ui.preview.height;
    var bctx = base.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.fillStyle = '#fff';
    bctx.fillRect(0, 0, w, h);
    state.base = base;
    drawStage();

    for (var i = 0; i < numbers.length; i++) {
      var page = await pdf.getPage(numbers[i]);
      if (token !== state.token) return;
      var rendered = await renderPageToCanvas(page, w * dpr);
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

  function drawStage() {
    var v = state.view;
    var ctx = ui.preview.getContext('2d');
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.clearRect(0, 0, v.w, v.h);
    if (state.base) ctx.drawImage(state.base, 0, 0, v.w, v.h);

    var b = bounds();
    var L = b.left * v.w, R = b.right * v.w, T = b.top * v.h, B = b.bottom * v.h;
    var S = clamp(state.split, b.left, b.right) * v.w;

    ctx.fillStyle = 'rgba(90, 100, 112, .55)';
    ctx.fillRect(0, 0, v.w, T);
    ctx.fillRect(0, B, v.w, v.h - B);
    ctx.fillRect(0, T, L, B - T);
    ctx.fillRect(R, T, v.w - R, B - T);

    ctx.fillStyle = 'rgba(15, 157, 120, .18)';
    ctx.fillRect(L, T, S - L, B - T);
    ctx.fillStyle = 'rgba(58, 110, 220, .18)';
    ctx.fillRect(S, T, R - S, B - T);

    ctx.strokeStyle = 'rgba(255, 255, 255, .9)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    line(ctx, L, T, L, B); line(ctx, R, T, R, B);
    line(ctx, L, T, R, T); line(ctx, L, B, R, B);
    ctx.setLineDash([]);

    ctx.strokeStyle = '#0f9d78';
    ctx.lineWidth = 2.5;
    line(ctx, S, T, S, B);
    ctx.fillStyle = '#0f9d78';
    ctx.beginPath();
    ctx.arc(S, (T + B) / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(S - 3.5, (T + B) / 2 - 3, 1.5, 6);
    ctx.fillRect(S + 2, (T + B) / 2 - 3, 1.5, 6);

    var label = pct(state.split);
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    var lw = ctx.measureText(label).width + 14;
    var ly = Math.min(T + 8, v.h - 26);
    ctx.fillStyle = '#0f9d78';
    ctx.fillRect(S - lw / 2, ly, lw, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, S, ly + 13);
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
      { key: 'split', axis: 'x', at: state.split },
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
      setSplit(p.x);
    } else if (key === 'left') {
      m.left = clamp(p.x, 0, 0.45);
      setSplit(state.split);
    } else if (key === 'right') {
      m.right = clamp(1 - p.x, 0, 0.45);
      setSplit(state.split);
    } else if (key === 'top') {
      m.top = clamp(p.y, 0, 0.45);
    } else if (key === 'bottom') {
      m.bottom = clamp(1 - p.y, 0, 0.45);
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

  /* ------------------------------------------------------------- controls */

  function setSplit(value) {
    var b = bounds();
    state.split = clamp(value, b.left + 0.01, b.right - 0.01);
  }

  function syncInputs() {
    ui.splitRange.value = (state.split * 100).toFixed(1);
    ui.splitPct.value = (state.split * 100).toFixed(1);
    Object.keys(ui.margin).forEach(function (k) {
      ui.margin[k].value = (state.margins[k] * 100).toFixed(1);
    });
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
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      var step = (e.shiftKey ? 0.01 : 0.001) * (e.key === 'ArrowLeft' ? -1 : 1);
      setSplit(state.split + step);
      syncInputs();
      drawStage();
      e.preventDefault();
    }
  });

  /* ---------------------------------------------------------------- split */

  ui.go.addEventListener('click', async function () {
    if (!state.file) return;
    ui.go.disabled = true;
    status('Working…');
    await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
    try {
      var bytes = new Uint8Array(await state.file.arrayBuffer());
      var skip = SplitCore.parsePageList(ui.skip.value, state.pageCount);
      var out = await SplitCore.splitPdfBytes(bytes, {
        split: state.split,
        margins: state.margins,
        skip: skip,
      });
      var pages = state.pageCount * 2 - skip.length;
      save(out, state.file.name.replace(/\.pdf$/i, '') + '-split.pdf');
      status('Done: ' + state.pageCount + ' → ' + pages + ' pages.');
    } catch (err) {
      status('Error: ' + err.message);
    }
    ui.go.disabled = false;
  });

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
