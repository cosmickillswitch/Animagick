/* Animath editor, laid out like a phone video editor: preview on top, a timeline that is always visible
   and scrolls under a fixed centre playhead, a toolbar along the bottom, and pop-up panels for editing. */
(function () {
  'use strict';
  const A = window.Animath;
  const $ = s => document.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
    return el;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const uid = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
  const clone = o => JSON.parse(JSON.stringify(o, (k, v) => k[0] === '_' ? undefined : v));
  const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
  const snap = v => Math.round(v * 20) / 20;
  const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  function toast(msg) { document.querySelectorAll('.toast').forEach(t => t.remove()); const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2400); }
  function ask(msg, ok = 'OK') {
    return new Promise(res => {
      const d = h('dialog', { class: 'ask' });
      d.append(h('div', { class: 'dlg' }, h('p', {}, msg), h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn quiet', onclick: () => { d.close(); res(false); } }, 'Cancel'),
        h('button', { type: 'button', class: 'btn danger', onclick: () => { d.close(); res(true); } }, ok))));
      d.addEventListener('close', () => setTimeout(() => d.remove(), 50));
      document.body.append(d); d.showModal();
    });
  }

  const ASPECTS = [['16:9', 'Landscape 16:9'], ['9:16', 'Portrait 9:16'], ['1:1', 'Square 1:1'], ['4:5', 'Portrait 4:5'], ['4:3', 'Classic 4:3'], ['21:9', 'Cinema 21:9']];
  const BGS = [['#000000', 'Black (Manim)'], ['#1E1E24', 'Charcoal'], ['#0E1A2B', 'Navy'], ['#FBF8F1', 'Paper'], ['#FFFFFF', 'White']];
  const SWATCH = ['WHITE', 'GREY', 'BLUE', 'TEAL', 'GREEN', 'YELLOW', 'GOLD', 'ORANGE', 'RED', 'MAROON', 'PURPLE', 'PINK', 'INK'];
  const ratio = a => { const [w, hh] = a.split(':').map(Number); return w / hh; };
  const isLight = bg => { const c = String(A.color(bg)).replace('#', ''); const n = parseInt(c.length === 3 ? c.split('').map(x => x + x).join('') : c, 16); return ((n >> 16 & 255) * 0.3 + (n >> 8 & 255) * 0.59 + (n & 255) * 0.11) > 150; };
  const fmtT = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
  const MT = A.MAT;
  const MORPH = k => k === 'transform' || k === 'transformMatch';
  const objById = id => (scene && id && scene.objects.find(o => o.id === id)) || null;
  function descendants(o) { const out = []; const walk = p => scene.objects.forEach(c => { if (c.parent === p.id && c !== o && !out.includes(c)) { out.push(c); walk(c); } }); walk(o); return out; }
  function ancestors(o) { const out = []; let p = o, n = 0; while (p && p.parent && n++ < 30) { p = objById(p.parent); if (p) out.unshift(p); } return out; }

  // ---------- state ----------
  let scene = null, projId = null, sel = null, time = 0, playing = false, t0 = 0, guides = false, pps = 56;
  let hist = [], hi = -1, saveT = null, dirty = true, sheetKind = null;
  const stage = $('#stage'), sctx = stage.getContext('2d');

  function newScene(name) { return { v: 2, name: name || 'Untitled', aspect: '16:9', bg: '#000000', duration: 10, objects: [], vars: [], markers: [] }; }
  function makeObj(type, over = {}) {
    const T = A.TYPES[type];
    const n = scene.objects.filter(o => o.type === type).length + 1;
    const props = clone(T.defaults);
    if (isLight(scene.bg)) for (const k of ['color', 'axis']) if (props[k] === 'WHITE') props[k] = 'INK';
    const textish = ['text', 'math', 'title', 'truth', 'textpath'].includes(type);
    const o = {
      id: uid(), type, name: T.label + ' ' + n, start: round(time, 2), end: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
      props, anIn: { type: textish ? 'write' : type === 'sticker' ? 'grow' : type === 'group' ? 'fadein' : type === 'image' ? 'fadein' : 'create', dur: type === 'graph' ? 2 : type === 'group' ? 0.5 : 1, rate: 'smooth' },
      anOut: { type: 'fadeout', dur: 0.6, rate: 'smooth' }, emph: [], keys: {}, loop: type === 'sticker' ? 'bob' : 'none'
    };
    o.end = round(o.start + 4, 2);
    Object.assign(o, over);
    if (over.props) o.props = Object.assign(props, over.props);
    return o;
  }

  // ---------- persistence and undo ----------
  const index = () => store.get('animath.index', []);
  function saveNow() {
    if (!scene || !projId) return;
    store.set('animath.p.' + projId, clone(scene));
    const ix = index().filter(p => p.id !== projId);
    ix.unshift({ id: projId, name: scene.name, updated: Date.now() });
    store.set('animath.index', ix);
  }
  function commit() {
    const s = JSON.stringify(clone(scene));
    if (hist[hi] === s) return;
    hist = hist.slice(0, hi + 1); hist.push(s); if (hist.length > 80) hist.shift(); hi = hist.length - 1;
    clearTimeout(saveT); saveT = setTimeout(saveNow, 300);
    updUndo();
  }
  let commitT = null;
  const commitSoon = () => { clearTimeout(commitT); commitT = setTimeout(commit, 400); };
  function undo(d) {
    const j = hi + d;
    if (j < 0 || j >= hist.length) return;
    hi = j; scene = JSON.parse(hist[hi]);
    if (sel && !scene.objects.some(o => o.id === sel)) sel = null;
    clearTimeout(saveT); saveT = setTimeout(saveNow, 300);
    refreshAll(); updUndo();
  }
  function updUndo() { $('#undo').disabled = hi <= 0; $('#redo').disabled = hi >= hist.length - 1; }
  function openProject(id) {
    const s = store.get('animath.p.' + id, null);
    if (!s) return false;
    projId = id; scene = s; sel = null; time = 0; playing = false;
    if (!scene.vars) scene.vars = [];
    if (!scene.markers) scene.markers = [];
    store.set('animath.current', id);
    loadMedia();
    hist = [JSON.stringify(clone(scene))]; hi = 0; updUndo();
    closeSheet(); refreshAll(); fillProjects();
    return true;
  }
  function createProject(s) { projId = uid(); scene = s; saveNow(); if (!openProject(projId)) { hist = [JSON.stringify(clone(scene))]; hi = 0; refreshAll(); fillProjects(); } }
  function fillProjects() {
    const p = $('#proj'); p.textContent = '';
    const ix = index();
    if (!ix.some(x => x.id === projId)) ix.unshift({ id: projId, name: scene.name });
    for (const it of ix) p.append(h('option', { value: it.id }, it.name));
    p.value = projId;
  }

  // ---------- media: images and sound live in IndexedDB, referenced by id from the scene ----------
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      try { const r = indexedDB.open('animath-media', 1); r.onupgradeneeded = () => r.result.createObjectStore('m'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); }
    }));
    return {
      async put(id, blob) { try { const db = await open(); await new Promise((res, rej) => { const tx = db.transaction('m', 'readwrite'); tx.objectStore('m').put(blob, id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; } catch (e) { return false; } },
      async get(id) { try { const db = await open(); return await new Promise((res, rej) => { const r = db.transaction('m').objectStore('m').get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); }); } catch (e) { return null; } }
    };
  })();
  const memMedia = new Map();
  async function putMedia(id, blob) { memMedia.set(id, blob); return idb.put(id, blob); }
  async function getMedia(id) { return memMedia.get(id) || await idb.get(id); }
  const sound = { id: null, el: null, buf: null, peaks: null, dur: 0, url: null };
  function mediaIds(sc) { const ids = new Set(sc.objects.filter(o => o.type === 'image' && o.props.src).map(o => o.props.src)); if (sc.audio && sc.audio.id) ids.add(sc.audio.id); return ids; }
  async function loadMedia() {
    for (const o of scene.objects) if (o.type === 'image' && o.props.src && !A.IMAGES.has(o.props.src)) {
      const id = o.props.src;
      A.IMAGES.set(id, { ok: false });
      getMedia(id).then(b => { if (b) A.setImage(id, URL.createObjectURL(b)).then(() => { A.fontsChanged(); dirty = true; }); else A.IMAGES.delete(id); });
    }
    const au = scene.audio;
    if (!au || !au.id) { if (sound.el) sound.el.pause(); Object.assign(sound, { id: null, el: null, buf: null, peaks: null, dur: 0 }); renderTimelineSoon(); return; }
    if (sound.id === au.id) return;
    sound.id = au.id;
    const b = await getMedia(au.id);
    if (!b || sound.id !== au.id) { if (!b) toast('The sound for this project isn’t on this device.'); return; }
    if (sound.url) URL.revokeObjectURL(sound.url);
    sound.url = URL.createObjectURL(b);
    sound.el = new Audio(sound.url); sound.el.preload = 'auto';
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const ab = await b.arrayBuffer();
      sound.buf = await new Promise((res, rej) => ac.decodeAudioData(ab, res, rej));
      sound.dur = sound.buf.duration;
      const ch = sound.buf.getChannelData(0), N = Math.min(4000, Math.ceil(sound.dur * 40)), step = Math.floor(ch.length / N) || 1;
      sound.peaks = new Float32Array(N);
      for (let i = 0; i < N; i++) { let m = 0; for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; } sound.peaks[i] = m; }
      ac.close && ac.close();
    } catch (e) { sound.buf = null; sound.peaks = null; sound.el.addEventListener('loadedmetadata', () => { sound.dur = sound.el.duration || 0; renderTimelineSoon(); }); }
    renderTimelineSoon();
  }
  // keep the sound in step with playback
  function syncSound() {
    const el = sound.el, au = scene.audio;
    if (!el || !au) return;
    el.volume = Math.max(0, Math.min(1, au.vol == null ? 1 : au.vol));
    const at = time - (au.offset || 0), dur = sound.dur || el.duration || 0;
    if (!playing || at < 0 || (dur && at >= dur)) { if (!el.paused) el.pause(); return; }
    if (el.paused) { try { el.currentTime = at; } catch (e) {} const p = el.play(); if (p && p.catch) p.catch(() => {}); }
    else if (Math.abs(el.currentTime - at) > 0.2) { try { el.currentTime = at; } catch (e) {} }
  }
  function blobToDataURL(b) { return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(b); }); }
  async function dataURLToBlob(u) { const r = await fetch(u); return r.blob(); }
  function pickFile(accept) {
    return new Promise(res => {
      const i = h('input', { type: 'file', accept, style: 'position:fixed;left:-9999px' });
      i.addEventListener('change', () => { res(i.files[0] || null); i.remove(); });
      document.body.append(i); i.click();
    });
  }
  async function importImage() {
    const f = await pickFile('image/*'); if (!f) return;
    try {
      const url = URL.createObjectURL(f);
      const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('that file isn’t an image this browser can read')); im.src = url; });
      let blob = f, w = img.naturalWidth, hh = img.naturalHeight;
      const MAX = 2048;
      if (Math.max(w, hh) > MAX) {
        const k = MAX / Math.max(w, hh), c = h('canvas'); c.width = Math.round(w * k); c.height = Math.round(hh * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        blob = await new Promise(res => c.toBlob(res, /png|gif|webp/.test(f.type) ? 'image/png' : 'image/jpeg', 0.9));
      }
      URL.revokeObjectURL(url);
      const id = 'img_' + uid();
      const saved = await putMedia(id, blob);
      await A.setImage(id, URL.createObjectURL(blob));
      const ar = hh / w, fit = Math.min(6, 5 / ar);
      addObj('image', { name: f.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Image', props: { src: id, ar: round(ar, 4), w: round(fit, 2) } });
      if (!saved) toast('Added. This browser won’t store images, so it lasts until you close the app.');
    } catch (e) { toast('Couldn’t add the image: ' + e.message); }
  }
  async function importSound() {
    const f = await pickFile('audio/*'); if (!f) return;
    const id = 'snd_' + uid();
    const saved = await putMedia(id, f);
    scene.audio = { id, name: f.name.replace(/\.[^.]+$/, '').slice(0, 30) || 'Sound', offset: 0, vol: 1 };
    commit();
    await loadMedia();
    if (sound.dur > scene.duration) { scene.duration = Math.ceil(sound.dur); commit(); }
    renderTimeline(); openSheet('audio');
    toast(saved ? 'Sound added. Tap ◆ Marker while it plays to mark the beats.' : 'Sound added for this session only (this browser won’t store it).');
  }

  // ---------- stage ----------
  const narrow = () => matchMedia('(max-width: 899px)').matches;
  function sizeStage() {
    const wrap = $('#stageWrap');
    const r = ratio(scene.aspect);
    const colW = $('#col').clientWidth;
    const maxW = colW - 16, maxH = Math.max(150, window.innerHeight * (narrow() ? 0.42 : 0.52));
    let w = maxW, hh = w / r;
    if (hh > maxH) { hh = maxH; w = hh * r; }
    w = Math.floor(w); hh = Math.floor(hh);
    stage.style.width = w + 'px'; stage.style.height = hh + 'px';
    wrap.style.height = (hh + 16) + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    stage.width = Math.round(w * dpr); stage.height = Math.round(hh * dpr);
    document.documentElement.style.setProperty('--sheet-top', (wrap.getBoundingClientRect().bottom) + 'px');
    dirty = true;
    syncScroll();
  }
  function draw() {
    const W = stage.width, H = stage.height;
    A.render(sctx, scene, time, W, H, { guides: true });
    const ppu = H / 8;
    if (guides) {
      sctx.save(); sctx.strokeStyle = isLight(scene.bg) ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.12)'; sctx.lineWidth = 1;
      const uw = W / ppu / 2;
      for (let x = -Math.floor(uw); x <= uw; x++) { sctx.beginPath(); sctx.moveTo(W / 2 + x * ppu, 0); sctx.lineTo(W / 2 + x * ppu, H); sctx.stroke(); }
      for (let y = -4; y <= 4; y++) { sctx.beginPath(); sctx.moveTo(0, H / 2 - y * ppu); sctx.lineTo(W, H / 2 - y * ppu); sctx.stroke(); }
      sctx.strokeStyle = isLight(scene.bg) ? 'rgba(0,0,0,.3)' : 'rgba(255,255,255,.3)';
      sctx.beginPath(); sctx.moveTo(W / 2, 0); sctx.lineTo(W / 2, H); sctx.moveTo(0, H / 2); sctx.lineTo(W, H / 2); sctx.stroke();
      sctx.restore();
    }
    const o = selObj();
    if (drw) drawOverlay(W, H);
    else if (o && o._hit && !playing) {
      const g = boxGeom(o, W, H), k = W / stage.getBoundingClientRect().width || 1;
      sctx.save();
      sctx.strokeStyle = '#FFFFFF'; sctx.lineWidth = 1.5 * k; sctx.shadowColor = 'rgba(0,0,0,.6)'; sctx.shadowBlur = 3 * k;
      sctx.beginPath(); g.corners.forEach(([x, y], i) => i ? sctx.lineTo(x, y) : sctx.moveTo(x, y)); sctx.closePath(); sctx.stroke();
      sctx.beginPath(); sctx.moveTo(...g.top); sctx.lineTo(...g.rot); sctx.stroke();
      sctx.fillStyle = '#FFFFFF';
      for (const [x, y] of g.corners) { sctx.beginPath(); sctx.rect(x - 5 * k, y - 5 * k, 10 * k, 10 * k); sctx.fill(); }
      for (const [x, y, ax] of g.sides) { sctx.save(); sctx.translate(x, y); sctx.rotate(ax); sctx.beginPath(); (sctx.roundRect ? sctx.roundRect(-7 * k, -3 * k, 14 * k, 6 * k, 3 * k) : sctx.rect(-7 * k, -3 * k, 14 * k, 6 * k)); sctx.fill(); sctx.restore(); }
      sctx.beginPath(); sctx.arc(g.rot[0], g.rot[1], 8 * k, 0, 7); sctx.fill();
      sctx.strokeStyle = '#111'; sctx.lineWidth = 1.6 * k; sctx.shadowBlur = 0;
      sctx.beginPath(); sctx.arc(g.rot[0], g.rot[1], 4 * k, -0.3, 4.4); sctx.stroke();
      if (o.pivot || pivotMode) {
        const [ax, ay] = g.anchor, rr = (pivotMode ? 11 : 7) * k;
        sctx.strokeStyle = pivotMode ? '#FFFF00' : '#FFFFFF'; sctx.lineWidth = 2 * k; sctx.shadowBlur = 3 * k;
        sctx.beginPath(); sctx.arc(ax, ay, rr, 0, 7); sctx.moveTo(ax - rr * 1.6, ay); sctx.lineTo(ax + rr * 1.6, ay); sctx.moveTo(ax, ay - rr * 1.6); sctx.lineTo(ax, ay + rr * 1.6); sctx.stroke();
      }
      if (o.type === 'group') { sctx.fillStyle = 'rgba(0,0,0,.55)'; sctx.fillRect(g.corners[0][0], g.corners[0][1] - 18 * k, 64 * k, 16 * k); sctx.fillStyle = '#fff'; sctx.font = (11 * k) + 'px "IBM Plex Sans", sans-serif'; sctx.textBaseline = 'middle'; sctx.fillText('⧈ Group', g.corners[0][0] + 4 * k, g.corners[0][1] - 10 * k); }
      sctx.restore();
    }
    if (pivotMode && o) {
      sctx.save(); const k = W / (stage.getBoundingClientRect().width || W);
      sctx.fillStyle = 'rgba(0,0,0,.55)'; sctx.fillRect(8 * k, 8 * k, 190 * k, 24 * k);
      sctx.fillStyle = '#FFFF00'; sctx.font = (12 * k) + 'px "IBM Plex Sans", sans-serif'; sctx.textBaseline = 'middle';
      sctx.fillText('⊕ Drag to move the pivot', 14 * k, 20 * k); sctx.restore();
    }
    $('#time').textContent = fmtT(time);
    $('#dur').textContent = fmtT(scene.duration);
    const kb = $('#keyBtn');
    if (kb) { const on = o && Object.values(o.keys || {}).some(k => k.some(q => Math.abs(q.t - time) < 0.026)); kb.classList.toggle('on', !!on); kb.disabled = !o; }
  }
  function loop() {
    if (playing) {
      time = (performance.now() - t0) / 1000;
      if (time >= scene.duration) {
        if ($('#loopBtn').getAttribute('aria-pressed') === 'true') { t0 = performance.now(); time = 0; }
        else { time = scene.duration; setPlaying(false); }
      }
      draw(); syncScroll(); syncSound();
    } else if (dirty) { draw(); dirty = false; }
    requestAnimationFrame(loop);
  }
  function setPlaying(on) {
    playing = on;
    if (on) { if (time >= scene.duration - 0.01) time = 0; t0 = performance.now() - time * 1000; }
    if (sound.el) {
      // start the sound from the tap itself, so phones allow it to play
      if (on) { const p = sound.el.play(); if (p && p.then) p.then(syncSound).catch(() => {}); else syncSound(); }
      else sound.el.pause();
    }
    document.querySelectorAll('.playbtn').forEach(b => { b.textContent = on ? '❚❚' : '▶'; b.setAttribute('aria-label', on ? 'Pause' : 'Play'); });
    dirty = true;
    if (!on) refreshSheetValues();
  }
  function setTime(t, fromScroll) {
    time = Math.max(0, Math.min(scene.duration, t)); dirty = true;
    if (!fromScroll) syncScroll();
    if (!playing) refreshSheetValues();
  }
  const selObj = () => (scene && scene.objects.find(o => o.id === sel)) || null;
  const GLOBAL_SHEETS = ['scene', 'add', 'media', 'library', 'values', 'camera', 'audio', 'code', 'ease'];
  function select(id) {
    if (drw && id !== drw.id) endDraw();
    sel = id; dirty = true;
    renderTools(); renderTimeline();
    pivotMode = false;
    if (sheetKind && !GLOBAL_SHEETS.includes(sheetKind.split(':')[0])) { if (id) openSheet(sheetKind); else closeSheet(); }
  }

  // ---------- Draw: pen, pencil and node editing for vector shapes ----------
  let drw = null;
  let drawStyle = Object.assign({ stroke: 'WHITE', sw: 4, fill: '', fo: 1 }, store.get('animath.drawstyle', {}));
  const drawObj = () => drw && scene.objects.find(o => o.id === drw.id);
  function objState(o) { const k = p => A.keyVal(o, p, time); return { x: k('x'), y: k('y'), s: k('scale'), sx: k('sx'), sy: k('sy'), r: k('rotation') * Math.PI / 180 }; }
  // frame units ↔ the object's own units, through parents, pivot and camera (from the last frame drawn)
  function toLocal(o, ux, uy) {
    const r = A.toLocalPt(o, ux, uy); if (r) return r;
    const st = objState(o), c = Math.cos(st.r), s = Math.sin(st.r); const dx = ux - st.x, dy = uy - st.y; const X = dx * c + dy * s, Y = -dx * s + dy * c; return [X / (st.s * st.sx || 1e-6), -Y / (st.s * st.sy || 1e-6)];
  }
  function toScreen(o, lx, ly, W, H) {
    const ppu = H / 8, f = A.toFramePt(o, lx, ly);
    if (f) return [W / 2 + f[0] * ppu, H / 2 - f[1] * ppu];
    const st = objState(o), c = Math.cos(st.r), s = Math.sin(st.r); const X = lx * st.s * st.sx, Y = -ly * st.s * st.sy; return [W / 2 + (st.x + X * c - Y * s) * ppu, H / 2 - (st.y + X * s + Y * c) * ppu];
  }
  // move an object by (dx, dy) in its parent's space, keyframes included
  function shiftPos(o, dx, dy) {
    for (const [p, d] of [['x', dx], ['y', dy]]) { if (o.keys[p] && o.keys[p].length) o.keys[p].forEach(k => { k.v = round(k.v + d, 3); }); else o[p] = round((o[p] || 0) + d, 3); }
  }
  function startDraw(existing) {
    if (playing) setPlaying(false);
    let o = existing;
    if (!o) {
      if (isLight(scene.bg) && drawStyle.stroke === 'WHITE') drawStyle.stroke = 'INK';
      o = makeObj('vector', { name: 'Drawing ' + (scene.objects.filter(x => x.type === 'vector').length + 1) });
      o.props.paths = [];
      scene.objects.push(o);
      if (o.end > scene.duration) scene.duration = Math.ceil(o.end);
      commit();
    }
    sel = o.id;
    drw = { id: o.id, tool: existing ? 'node' : 'pen', path: null, node: null, pen: null, drag: null, lastTap: 0 };
    const { inD, outD } = A.phases(o);
    if (time < o.start + inD || time > o.end - outD) setTime(Math.min(o.end - outD - 0.01, o.start + inD + 0.01));
    closeSheet(); renderTools(); renderTimeline(); dirty = true;
    toast(existing ? 'Drag nodes and handles. Tap a line to add a node.' : 'Pen: tap for corners, drag for curves');
  }
  function endDraw() {
    const o = drawObj();
    drw = null;
    if (o) {
      o.props.paths = (o.props.paths || []).filter(p => p.nodes.length);
      if (!o.props.paths.length) { scene.objects = scene.objects.filter(x => x !== o); sel = null; }
      else normaliseDrawing(o);
      commit();
    }
    closeSheet(); renderTools(); renderTimeline(); dirty = true;
  }
  // keep the object's origin at the drawing's centre, so rotating and resizing pivot around the middle
  function normaliseDrawing(o) {
    const ns = o.props.paths.flatMap(p => p.nodes);
    if (!ns.length) return;
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    if (Math.abs(cx) < 1e-6 && Math.abs(cy) < 1e-6) return;
    ns.forEach(n => { n.x = round(n.x - cx, 4); n.y = round(n.y - cy, 4); });
    // a set pivot stays where it was on the drawing; otherwise the position moves to the new middle
    if (o.pivot) { o.pivot = [round(o.pivot[0] - cx, 4), round(o.pivot[1] + cy, 4)]; return; }
    const st = objState(o), c = Math.cos(st.r), s = Math.sin(st.r);
    const X = cx * st.s * st.sx, Y = -cy * st.s * st.sy, dx = X * c - Y * s, dy = X * s + Y * c;
    shiftPos(o, dx, dy);
  }
  const newPath = n => ({ nodes: [n], closed: false, stroke: drawStyle.stroke, sw: drawStyle.sw, fill: drawStyle.fill, fo: drawStyle.fo });
  function reversePath(p) { p.nodes.reverse(); p.nodes.forEach(n => { [n.ix, n.ox] = [n.ox, n.ix]; [n.iy, n.oy] = [n.oy, n.iy]; }); }
  function smoothHandles(p, i) {
    const n = p.nodes, N = n.length, a = n[i];
    const prev = i > 0 ? n[i - 1] : p.closed ? n[N - 1] : null, next = i < N - 1 ? n[i + 1] : p.closed ? n[0] : null;
    if (!prev && !next) return;
    const tx = ((next || a).x - (prev || a).x) / (prev && next ? 4 : 3), ty = ((next || a).y - (prev || a).y) / (prev && next ? 4 : 3);
    Object.assign(a, { ox: tx, oy: ty, ix: -tx, iy: -ty, smooth: true });
  }
  function bezPoint(a, b, t) {
    const P0 = [a.x, a.y], P1 = [a.x + (a.ox || 0), a.y + (a.oy || 0)], P2 = [b.x + (b.ix || 0), b.y + (b.iy || 0)], P3 = [b.x, b.y];
    const L = (p, q) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const A1 = L(P0, P1), B1 = L(P1, P2), C1 = L(P2, P3), A2 = L(A1, B1), B2 = L(B1, C1), M = L(A2, B2);
    return { M, A1, A2, B2, C1 };
  }
  function drawDown(e) {
    const o = drawObj(); if (!o) { drw = null; return; }
    const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const [ux, uy] = toUnits(e, r), [lx, ly] = toLocal(o, ux, uy);
    const P = o.props.paths || (o.props.paths = []);
    const near = (x, y, tol = 18) => { const [a, b] = toScreen(o, x, y, r.width, r.height); return Math.hypot(a - mx, b - my) < tol; };
    stage.setPointerCapture(e.pointerId);
    const selNode = drw.path != null && P[drw.path] ? P[drw.path].nodes[drw.node] : null;
    if (selNode && drw.tool !== 'pencil') for (const k of ['i', 'o']) {
      const hx = selNode[k + 'x'] || 0, hy = selNode[k + 'y'] || 0;
      if ((hx || hy) && near(selNode.x + hx, selNode.y + hy)) { drw.drag = { kind: 'handle', k, nd: selNode }; return; }
    }
    let hit = null;
    P.forEach((p, pi) => p.nodes.forEach((n, ni) => { if (!hit && near(n.x, n.y)) hit = [pi, ni]; }));
    if (drw.tool === 'pencil') { drw.drag = { kind: 'pencil', pts: [[lx, ly]] }; return; }
    if (drw.tool === 'pen') {
      const ap = drw.pen != null && P[drw.pen] && !P[drw.pen].closed ? P[drw.pen] : null;
      if (hit && ap && hit[0] === drw.pen) {
        if (hit[1] === 0 && ap.nodes.length >= 2) { ap.closed = true; drw.pen = null; drw.path = hit[0]; drw.node = 0; toast('Shape closed'); commit(); dirty = true; renderTools(); return; }
        if (hit[1] === ap.nodes.length - 1) { drw.pen = null; drw.path = hit[0]; drw.node = hit[1]; toast('Line finished'); dirty = true; renderTools(); return; }
      }
      if (hit && !ap) {
        const p = P[hit[0]];
        if (!p.closed && (hit[1] === 0 || hit[1] === p.nodes.length - 1)) { if (hit[1] === 0) reversePath(p); drw.pen = hit[0]; drw.path = hit[0]; drw.node = p.nodes.length - 1; toast('Carrying on from this end'); dirty = true; renderTools(); return; }
        drw.path = hit[0]; drw.node = hit[1]; drw.drag = { kind: 'node', nd: p.nodes[hit[1]], pi: hit[0], ni: hit[1], last: [lx, ly] }; dirty = true; renderTools(); return;
      }
      const n = { x: round(lx, 4), y: round(ly, 4) };
      if (ap) ap.nodes.push(n); else { P.push(newPath(n)); drw.pen = P.length - 1; }
      drw.path = drw.pen; drw.node = P[drw.pen].nodes.length - 1;
      drw.drag = { kind: 'pull', nd: n };
      dirty = true; renderTools(); return;
    }
    // node tool
    if (hit) {
      const now = performance.now(), same = drw.path === hit[0] && drw.node === hit[1];
      drw.path = hit[0]; drw.node = hit[1];
      if (same && now - drw.lastTap < 380) { toggleSmooth(); drw.lastTap = 0; return; }
      drw.lastTap = now;
      drw.drag = { kind: 'node', nd: P[hit[0]].nodes[hit[1]], pi: hit[0], ni: hit[1], last: [lx, ly] };
      dirty = true; renderTools(); return;
    }
    // tap on a line: add a node there
    let best = null;
    P.forEach((p, pi) => {
      const n = p.nodes, segs = n.length - 1 + (p.closed ? 1 : 0);
      for (let i = 0; i < segs; i++) for (let k = 1; k < 24; k++) {
        const t = k / 24, q = bezPoint(n[i], n[(i + 1) % n.length], t).M;
        const [a, b] = toScreen(o, q[0], q[1], r.width, r.height), d = Math.hypot(a - mx, b - my);
        if (d < 16 && (!best || d < best.d)) best = { d, pi, i, t };
      }
    });
    if (best) {
      const p = P[best.pi], a = p.nodes[best.i], b = p.nodes[(best.i + 1) % p.nodes.length], q = bezPoint(a, b, best.t);
      const curved = a.ox || a.oy || b.ix || b.iy;
      const m = { x: q.M[0], y: q.M[1], smooth: !!curved };
      if (curved) { a.ox = q.A1[0] - a.x; a.oy = q.A1[1] - a.y; b.ix = q.C1[0] - b.x; b.iy = q.C1[1] - b.y; m.ix = q.A2[0] - m.x; m.iy = q.A2[1] - m.y; m.ox = q.B2[0] - m.x; m.oy = q.B2[1] - m.y; }
      p.nodes.splice(best.i + 1, 0, m);
      drw.path = best.pi; drw.node = best.i + 1;
      drw.drag = { kind: 'node', nd: m, pi: best.pi, ni: best.i + 1, last: [lx, ly] };
      toast('Node added'); dirty = true; renderTools(); return;
    }
    drw.path = null; drw.node = null; dirty = true; renderTools();
  }
  function drawMove(e) {
    const d = drw && drw.drag; if (!d) return;
    const o = drawObj(); const r = stage.getBoundingClientRect();
    const [ux, uy] = toUnits(e, r), [lx, ly] = toLocal(o, ux, uy);
    d.moved = true;
    if (d.kind === 'pull') {
      let ox = lx - d.nd.x, oy = ly - d.nd.y;
      if (Math.hypot(ox, oy) < 0.06) { ox = 0; oy = 0; }
      Object.assign(d.nd, { ox, oy, ix: -ox, iy: -oy, smooth: !!(ox || oy) });
    } else if (d.kind === 'handle') {
      const nd = d.nd, k = d.k, other = k === 'i' ? 'o' : 'i';
      nd[k + 'x'] = lx - nd.x; nd[k + 'y'] = ly - nd.y;
      if (nd.smooth) { const L = Math.hypot(nd[other + 'x'] || 0, nd[other + 'y'] || 0), M = Math.hypot(nd[k + 'x'], nd[k + 'y']) || 1; nd[other + 'x'] = -nd[k + 'x'] / M * L; nd[other + 'y'] = -nd[k + 'y'] / M * L; }
    } else if (d.kind === 'node') {
      d.nd.x += lx - d.last[0]; d.nd.y += ly - d.last[1]; d.last = [lx, ly];
    } else if (d.kind === 'pencil') {
      const q = d.pts[d.pts.length - 1];
      if (Math.hypot(lx - q[0], ly - q[1]) > 0.02) d.pts.push([lx, ly]);
    }
    dirty = true;
  }
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    let idx = 0, dm = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
      const d = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / L;
      if (d > dm) { dm = d; idx = i; }
    }
    if (dm <= eps) return [a, b];
    return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  }
  function drawUp() {
    const d = drw && drw.drag; if (!drw) return;
    drw.drag = null;
    const o = drawObj(), P = o ? o.props.paths : [];
    if (!d) return;
    if (d.kind === 'pencil') {
      if (d.pts.length < 2) { dirty = true; return; }
      const st = objState(o);
      let pts = rdp(d.pts, 0.05 / Math.max(0.05, Math.abs(st.s)));
      let closed = false;
      const f = pts[0], l = pts[pts.length - 1];
      if (pts.length >= 4 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.3 / Math.max(0.05, Math.abs(st.s))) { pts = pts.slice(0, -1); closed = true; }
      const p = newPath({ x: pts[0][0], y: pts[0][1] });
      p.nodes = pts.map(([x, y]) => ({ x: round(x, 4), y: round(y, 4) }));
      p.closed = closed;
      if (pts.length > 2) p.nodes.forEach((_, i) => smoothHandles(p, i));
      P.push(p); drw.path = P.length - 1; drw.node = null;
      if (closed) toast('Closed shape drawn');
    } else if (d.kind === 'node' && d.moved) {
      // drop an end onto another end to join lines, or onto its own start to close the shape
      const p = P[d.pi];
      if (p && !p.closed && (d.ni === 0 || d.ni === p.nodes.length - 1)) {
        const r = stage.getBoundingClientRect();
        const scr = n => toScreen(o, n.x, n.y, r.width, r.height);
        const me = scr(d.nd);
        const otherEnd = d.ni === 0 ? p.nodes[p.nodes.length - 1] : p.nodes[0];
        if (p.nodes.length >= 3) { const q = scr(otherEnd); if (Math.hypot(q[0] - me[0], q[1] - me[1]) < 18) { if (d.ni === 0) p.nodes.shift(); else p.nodes.pop(); p.closed = true; drw.node = 0; toast('Shape closed'); } }
        if (!p.closed) {
          for (let qi = 0; qi < P.length; qi++) {
            const B = P[qi]; if (qi === d.pi || B.closed) continue;
            const ends = [0, B.nodes.length - 1];
            const hitEnd = ends.find(ei => { const q = scr(B.nodes[ei]); return Math.hypot(q[0] - me[0], q[1] - me[1]) < 18; });
            if (hitEnd == null) continue;
            if (d.ni === 0) reversePath(p);
            if (hitEnd !== 0) reversePath(B);
            const dragged = p.nodes.pop();
            if (dragged.ix || dragged.iy) { B.nodes[0].ix = dragged.ix; B.nodes[0].iy = dragged.iy; }
            p.nodes.push(...B.nodes);
            P.splice(qi, 1);
            drw.path = P.indexOf(p); drw.node = null; toast('Lines joined');
            break;
          }
        }
      }
    }
    commit(); dirty = true; renderTools();
  }
  function toggleSmooth() {
    const o = drawObj(); if (!o || drw.path == null || drw.node == null) return;
    const p = o.props.paths[drw.path], n = p && p.nodes[drw.node]; if (!n) return;
    if (n.ox || n.oy || n.ix || n.iy) { Object.assign(n, { ox: 0, oy: 0, ix: 0, iy: 0, smooth: false }); toast('Corner'); }
    else { smoothHandles(p, drw.node); toast('Smooth'); }
    commit(); dirty = true; renderTools();
  }
  function drawAction(kind) {
    const o = drawObj(); if (!o) return;
    const P = o.props.paths, p = drw.path != null ? P[drw.path] : null;
    if (kind === 'close' && p) { p.closed = !p.closed; if (p.closed && !p.fill) { p.fill = drawStyle.fill || p.stroke; p.fo = p.fo == null ? 1 : p.fo; } toast(p.closed ? 'Shape closed: fill it in Style' : 'Shape opened'); if (drw.pen === drw.path) drw.pen = null; }
    else if (kind === 'delnode' && p && drw.node != null) { p.nodes.splice(drw.node, 1); if (p.nodes.length < 3) p.closed = false; if (!p.nodes.length) { P.splice(drw.path, 1); drw.path = null; drw.pen = null; } drw.node = null; }
    else if (kind === 'delpath' && p) { P.splice(drw.path, 1); drw.path = null; drw.node = null; drw.pen = null; }
    else if (kind === 'newline') { drw.tool = 'pen'; drw.pen = null; drw.path = null; drw.node = null; toast('Tap to start a new line'); }
    commit(); dirty = true; renderTools(); refreshSheet();
  }
  function renderDrawTools(bar) {
    const o = drawObj();
    const p = o && drw.path != null ? o.props.paths[drw.path] : null;
    const hasNode = p && drw.node != null;
    const t = (icon, label, fn, cls, dis) => { const b = tool(icon, label, fn, cls); if (dis) b.disabled = true; return b; };
    bar.append(t('✓', 'Done', endDraw, 'back'),
      t('✒', 'Pen', () => { drw.tool = 'pen'; renderTools(); }, drw.tool === 'pen' ? 'active' : ''),
      t('✎', 'Pencil', () => { drw.tool = 'pencil'; drw.pen = null; renderTools(); }, drw.tool === 'pencil' ? 'active' : ''),
      t('⌖', 'Nodes', () => { drw.tool = 'node'; drw.pen = null; renderTools(); }, drw.tool === 'node' ? 'active' : ''),
      t('◐', 'Style', () => openSheet('drawstyle'), sheetKind === 'drawstyle' ? 'active' : ''),
      t('∿', 'Smooth', toggleSmooth, '', !hasNode),
      t('◯', p && p.closed ? 'Open' : 'Close', () => drawAction('close'), '', !p || p.nodes.length < 3),
      t('＋', 'New line', () => drawAction('newline')),
      t('⌫', 'Del node', () => drawAction('delnode'), '', !hasNode),
      t('✕', 'Del line', () => drawAction('delpath'), 'danger', !p));
  }
  function drawStyleSheet(body) {
    const o = drawObj(); if (!o) return;
    const p = drw.path != null ? o.props.paths[drw.path] : null;
    const cur = p || drawStyle;
    const set = (k, v) => { drawStyle[k] = v; store.set('animath.drawstyle', drawStyle); if (p) p[k] = v; dirty = true; commitSoon(); };
    body.append(h('p', { class: 'muted small' }, p ? 'Changes the selected line, and new lines too.' : 'Sets the style for new lines. Select a line (Nodes tool) to change it.'));
    body.append(field('Line colour', colorField(cur.stroke, v => set('stroke', v))));
    body.append(field('Thickness (0 = no outline)', stepper(cur.sw, 1, v => set('sw', Math.max(0, v)))));
    body.append(field('Fill (closed shapes; ∅ = none)', colorField(cur.fill || '', v => set('fill', v), true)));
    body.append(field('Fill opacity', stepper(cur.fo == null ? 1 : cur.fo, 0.1, v => set('fo', Math.max(0, Math.min(1, v))))));
    if (p && p.nodes.length >= 3) body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => { drawAction('close'); } }, p.closed ? 'Open the shape' : 'Close into a shape')));
    body.append(h('p', { class: 'muted small' }, 'Pen: tap for a corner, drag for a curve, tap the first node to close. Pencil: draw freely; it becomes smooth, editable nodes. Nodes: drag nodes and their handles, tap a line to add a node, double-tap a node to switch smooth/corner, drop an end on another end to join.'));
  }
  function drawOverlay(W, H) {
    const o = drawObj(); if (!o) return;
    const k = W / (stage.getBoundingClientRect().width || W);
    const S = (x, y) => toScreen(o, x, y, W, H);
    const P = o.props.paths || [];
    sctx.save();
    sctx.lineWidth = 1.2 * k;
    P.forEach((p, pi) => {
      const active = pi === drw.path;
      p.nodes.forEach((n, ni) => {
        const [x, y] = S(n.x, n.y), selN = active && ni === drw.node;
        if (selN) for (const kk of ['i', 'o']) {
          const hx = n[kk + 'x'] || 0, hy = n[kk + 'y'] || 0; if (!hx && !hy) continue;
          const [a, b] = S(n.x + hx, n.y + hy);
          sctx.strokeStyle = '#7FB8FF'; sctx.beginPath(); sctx.moveTo(x, y); sctx.lineTo(a, b); sctx.stroke();
          sctx.fillStyle = '#7FB8FF'; sctx.beginPath(); sctx.arc(a, b, 5 * k, 0, 7); sctx.fill();
        }
        const r = (selN ? 7 : 5) * k;
        sctx.fillStyle = selN ? '#FFFF00' : active ? '#FFFFFF' : 'rgba(255,255,255,.55)';
        sctx.strokeStyle = '#000'; sctx.lineWidth = 1.5 * k;
        sctx.beginPath();
        if (n.ox || n.oy || n.ix || n.iy) sctx.arc(x, y, r, 0, 7); else sctx.rect(x - r, y - r, 2 * r, 2 * r);
        sctx.fill(); sctx.stroke();
        if (drw.tool === 'pen' && drw.pen === pi && ni === 0 && p.nodes.length >= 2) { sctx.strokeStyle = '#FFFF00'; sctx.lineWidth = 2 * k; sctx.beginPath(); sctx.arc(x, y, 12 * k, 0, 7); sctx.stroke(); }
      });
    });
    if (drw.drag && drw.drag.kind === 'pencil') {
      sctx.strokeStyle = A.color(drawStyle.stroke) || '#fff'; sctx.lineWidth = 2 * k; sctx.lineJoin = 'round'; sctx.lineCap = 'round';
      sctx.beginPath(); drw.drag.pts.forEach(([x, y], i) => { const [a, b] = S(x, y); i ? sctx.lineTo(a, b) : sctx.moveTo(a, b); }); sctx.stroke();
    }
    sctx.fillStyle = 'rgba(0,0,0,.55)'; sctx.fillRect(8 * k, 8 * k, 118 * k, 24 * k);
    sctx.fillStyle = '#FFFF00'; sctx.font = (12 * k) + 'px "IBM Plex Sans", sans-serif'; sctx.textBaseline = 'middle';
    sctx.fillText('✎ Drawing · ' + ({ pen: 'Pen', pencil: 'Pencil', node: 'Nodes' }[drw.tool]), 14 * k, 20 * k);
    sctx.restore();
  }

  // ---------- transform box: corners scale evenly, side bars stretch one way, the round handle rotates ----------
  function boxGeom(o, W, H) {
    const { P, bb } = o._hit, ppu = H / 8;
    const PF = MT.mul(P, MT.FLIP);
    const S = (lx, ly) => { const [x, y] = MT.ap(PF, lx, ly); return [W / 2 + x * ppu, H / 2 - y * ppu]; };
    const lx = Math.hypot(P[0], P[1]) || 1, ly = Math.hypot(P[2], P[3]) || 1;
    const px = 0.13 / lx, py = 0.13 / ly;
    const x0 = bb[0] - px, x1 = bb[2] + px, y0 = bb[1] - py, y1 = bb[3] + py, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const corners = [S(x0, y0), S(x1, y0), S(x1, y1), S(x0, y1)];
    const top = S(cx, y0), center = S(cx, cy);
    const dx = top[0] - center[0], dy = top[1] - center[1], L = Math.hypot(dx, dy) || 1, k = W / (stage.getBoundingClientRect().width || W);
    const rot = [top[0] + dx / L * 30 * k, top[1] + dy / L * 30 * k];
    const ang = Math.atan2(-P[1], P[0]);
    const sides = [[...top, ang], [...S(x1, cy), ang + Math.PI / 2], [...S(cx, y1), ang], [...S(x0, cy), ang + Math.PI / 2]];
    const pv = o.pivot || [0, 0], af = MT.ap(P, pv[0], pv[1]);
    return { corners, sides, top, rot, center, anchor: [W / 2 + af[0] * ppu, H / 2 - af[1] * ppu], anchorU: af };
  }
  let sdrag = null;
  const toUnits = (e, r) => { const ppu = r.height / 8; return [(e.clientX - r.left - r.width / 2) / ppu, -(e.clientY - r.top - r.height / 2) / ppu]; };
  // tapping a member of a group picks the group first, then the member on the next tap
  function pickTarget(c) {
    const cur = selObj(), path = cur ? [...ancestors(cur), cur].map(x => x.id) : [];
    for (const g of ancestors(c).filter(x => x.type === 'group')) if (!path.includes(g.id)) return g;
    return c;
  }
  let pivotMode = false;
  function setPivot(o, pv) {
    const old = o.pivot || [0, 0];
    const st = objState(o), RS = MT.mul(MT.mR(st.r), MT.mS(st.s * st.sx, st.s * st.sy));
    const [dx, dy] = MT.apv(RS, pv[0] - old[0], pv[1] - old[1]);
    o.pivot = Math.abs(pv[0]) < 1e-6 && Math.abs(pv[1]) < 1e-6 ? undefined : [round(pv[0], 4), round(pv[1], 4)];
    shiftPos(o, dx, dy);
  }
  stage.addEventListener('pointerdown', e => {
    if (drw) { drawDown(e); return; }
    const r = stage.getBoundingClientRect();
    const [ux, uy] = toUnits(e, r);
    const cur = selObj();
    if (cur && cur._hit && !playing && pivotMode) {
      sdrag = { o: cur, mode: 'pivot', ux, uy, moved: false, snap: clone({ x: cur.x, y: cur.y, kx: cur.keys.x, ky: cur.keys.y, pivot: cur.pivot }), Pi: MT.inv(cur._hit.P) };
      stage.setPointerCapture(e.pointerId);
      return;
    }
    if (cur && cur._hit && !playing) {
      const g = boxGeom(cur, r.width, r.height), mx = e.clientX - r.left, my = e.clientY - r.top;
      const near = ([x, y]) => Math.hypot(x - mx, y - my) < 20;
      let mode = null;
      if (near(g.rot)) mode = 'rot';
      else if (g.corners.some(near)) mode = 'corner';
      else { const i = g.sides.findIndex(near); if (i >= 0) mode = i % 2 ? 'sx' : 'sy'; }
      if (mode) {
        const k = p => A.keyVal(cur, p, time), P = cur._hit.P;
        const nx = MT.apv(P, 1, 0), ny = MT.apv(P, 0, 1), Lx = Math.hypot(...nx) || 1, Ly = Math.hypot(...ny) || 1;
        sdrag = { o: cur, mode, ux, uy, ax: g.anchorU[0], ay: g.anchorU[1], axX: [nx[0] / Lx, nx[1] / Lx], axY: [ny[0] / Ly, ny[1] / Ly], flip: Math.sign(P[0] * P[3] - P[1] * P[2]) || 1,
          s0: k('scale'), sx0: k('sx'), sy0: k('sy'), r0: k('rotation'), moved: false };
        stage.setPointerCapture(e.pointerId);
        return;
      }
    }
    const hit = A.hitTest(scene, ux, uy);
    if (!hit) { if (sel) select(null); return; }
    const o = pickTarget(hit);
    if (o.id !== sel) select(o.id);
    if (playing) setPlaying(false);
    const bi = o._hit ? MT.inv(o._hit.base) : MT.I;
    sdrag = { o, mode: 'move', ux, uy, bi, x0: A.keyVal(o, 'x', time), y0: A.keyVal(o, 'y', time), moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    if (drw) { drawMove(e); return; }
    if (!sdrag) return;
    const r = stage.getBoundingClientRect();
    const [ux, uy] = toUnits(e, r);
    const d = sdrag;
    if (!d.moved && Math.hypot(ux - d.ux, uy - d.uy) < 0.05) return;
    d.moved = true;
    const o = d.o;
    if (d.mode === 'pivot') {
      // measured against the drag's starting frame, so small roundings don't build up
      const [lx, ly] = MT.ap(d.Pi, ux, uy), s0 = d.snap;
      o.x = s0.x; o.y = s0.y; if (s0.kx) o.keys.x = clone(s0.kx); if (s0.ky) o.keys.y = clone(s0.ky); o.pivot = s0.pivot && s0.pivot.slice();
      setPivot(o, [lx, ly]);
    } else if (d.mode === 'move') {
      const [ddx, ddy] = MT.apv(d.bi, ux - d.ux, uy - d.uy);
      let nx = d.x0 + ddx, ny = d.y0 + ddy;
      if (guides) { nx = Math.round(nx * 4) / 4; ny = Math.round(ny * 4) / 4; }
      setProp(o, 'x', round(nx, 2)); setProp(o, 'y', round(ny, 2));
    } else if (d.mode === 'corner') {
      const f = Math.hypot(ux - d.ax, uy - d.ay) / (Math.hypot(d.ux - d.ax, d.uy - d.ay) || 1);
      setProp(o, 'scale', round(Math.max(0.05, d.s0 * f), 3));
    } else if (d.mode === 'sx' || d.mode === 'sy') {
      const ax = d.mode === 'sx' ? d.axX : d.axY;
      const p0 = (d.ux - d.ax) * ax[0] + (d.uy - d.ay) * ax[1], p1 = (ux - d.ax) * ax[0] + (uy - d.ay) * ax[1];
      let v = (d.mode === 'sx' ? d.sx0 : d.sy0) * (p1 / (p0 || 1e-6));
      if (Math.abs(v) < 0.05) v = 0.05 * (Math.sign(v) || 1);
      setProp(o, d.mode, round(v, 3));
    } else if (d.mode === 'rot') {
      let deg = d.r0 + d.flip * (Math.atan2(uy - d.ay, ux - d.ax) - Math.atan2(d.uy - d.ay, d.ux - d.ax)) * 180 / Math.PI;
      const snapTo = Math.round(deg / 15) * 15;
      if (Math.abs(deg - snapTo) < 4) deg = snapTo;
      setProp(o, 'rotation', round(deg, 1));
    }
    dirty = true; refreshSheetValues();
  });
  const endDrag = () => { if (drw) { drawUp(); return; } if (sdrag && sdrag.moved) { commit(); renderTimeline(); } sdrag = null; };
  stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', () => { if (selObj()) openSheet('edit'); });

  function setProp(o, p, v) {
    const k = o.keys[p];
    if (k && k.length) {
      const t = round(time, 2);
      const ex = k.find(q => Math.abs(q.t - t) < 0.026);
      if (ex) ex.v = v; else { k.push({ t, v }); k.sort((a, b) => a.t - b.t); }
    } else o[p] = v;
  }
  function keyHere(o) { return Object.values(o.keys || {}).some(k => k.some(q => Math.abs(q.t - time) < 0.026)); }
  function toggleAllKeys() {
    const o = selObj(); if (!o) return;
    const t = round(time, 2);
    if (keyHere(o)) {
      for (const p of Object.keys(o.keys)) { o.keys[p] = o.keys[p].filter(q => Math.abs(q.t - t) >= 0.026); if (!o.keys[p].length) delete o.keys[p]; }
      toast('Keyframe removed at ' + fmtT(t));
    } else {
      for (const p of A.KEYABLE) { const k = o.keys[p] || (o.keys[p] = []); k.push({ t, v: A.keyVal(o, p, time) }); k.sort((a, b) => a.t - b.t); }
      toast('Keyframe added. Move the playhead, then drag or edit the object.');
    }
    commit(); renderTimeline(); dirty = true; refreshSheet();
  }
  function toggleKey(o, p) {
    const t = round(time, 2);
    const k = o.keys[p] || (o.keys[p] = []);
    const i = k.findIndex(q => Math.abs(q.t - t) < 0.026);
    if (i >= 0) { k.splice(i, 1); if (!k.length) delete o.keys[p]; }
    else { k.push({ t, v: A.keyVal(o, p, time) }); k.sort((a, b) => a.t - b.t); }
    commit(); refreshSheet(); renderTimeline(); dirty = true;
  }

  // ---------- add catalogue ----------
  const CATS = {
    text: { label: 'Text', icon: 'T', items: [['title', {}, 'Title card', 'H'], ['text', {}, 'Text', 'T'], ['math', {}, 'Maths', '∑'], ['math', { props: { tex: 'f(x) &= x^2 + 2x + 1 \\\\ &= (x+1)^2' } }, 'Working', '≡'], ['text', { props: { text: 'Note', size: 0.45, font: 'sans', color: 'GREY' } }, 'Caption', 'a'],
      ['textpath', {}, 'Curved text', '⌒'], ['textpath', { props: { shape: 'circle', text: 'ROUND AND ROUND • ', font: 'sans', size: 0.42 }, loop: 'spin' }, 'Text ring', '◌'], ['textpath', { props: { shape: 'wave', text: 'Making waves' } }, 'Wavy text', '〰'],
      ['math', { name: 'Live number', props: { tex: 'a = [[a:1]]' } }, 'Live number', '#']] },
    shapes: { label: 'Shapes', icon: '◯', items: [['shape', { props: { shape: 'circle' } }, 'Circle', '◯'], ['shape', { props: { shape: 'square', fo: 0.3 } }, 'Square', '□'], ['shape', { props: { shape: 'rect', color: 'WHITE', fill: 'WHITE', fo: 0 } }, 'Rectangle', '▭'],
      ['shape', { props: { shape: 'polygon', n: 6, color: 'TEAL', fill: 'TEAL', fo: 0.2 } }, 'Polygon', '⬡'], ['shape', { props: { shape: 'star', n: 5, color: 'GOLD', fill: 'GOLD', fo: 0.6 } }, 'Star', '☆'], ['shape', { props: { shape: 'ellipse', color: 'GREEN', fill: 'GREEN', fo: 0.2 } }, 'Ellipse', '⬭'],
      ['shape', { props: { shape: 'arrow', color: 'WHITE' } }, 'Arrow', '→'], ['shape', { props: { shape: 'darrow', color: 'WHITE' } }, 'Both ways', '↔'], ['shape', { props: { shape: 'line', color: 'WHITE' } }, 'Line', '—'],
      ['shape', { props: { shape: 'dot', color: 'YELLOW' } }, 'Dot', '•'], ['shape', { props: { shape: 'arc', color: 'YELLOW' } }, 'Arc', '◠'], ['shape', { props: { shape: 'brace', w: 3, color: 'WHITE' } }, 'Brace', '⏟'],
      ['geom', {}, 'Triangle', '△'], ['geom', { props: { pts: '-2,-1.2  2,-1.2  -2,1.6', labels: 'A B C', sides: 'a b c' } }, 'Right triangle', '◺']] },
    graph: { label: 'Graph', icon: '∿', items: [['graph', {}, 'sin & cos', '∿'], ['graph', { props: { f1: 'x^2/2', l1: 'y = \\tfrac{x^2}{2}', f2: '', xmin: -4, xmax: 4, ymin: -1, ymax: 6, area: true, a: 0, b: 2 } }, 'Area', '∫'],
      ['graph', { props: { f1: 'exp(x)', l1: 'e^x', f2: 'ln(x)', l2: '\\ln x', xmin: -3, xmax: 5, ymin: -3, ymax: 5, grid: true } }, 'Exp & log', 'eˣ'], ['graph', { props: { f1: '1/(1+exp(-x))', l1: '\\sigma(x)', f2: '', xmin: -6, xmax: 6, ymin: -0.2, ymax: 1.2, tracer: true } }, 'Sigmoid', 'σ'],
      ['graph', { props: { f1: '', f2: '', l1: '', xmin: -5, xmax: 5, ymin: -3, ymax: 3, grid: true } }, 'Empty axes', '┼']] },
    logic: { label: 'Logic', icon: '∀', items: [['venn', {}, 'Venn 2', '◎'], ['venn', { props: { n: 3, shade: '(A ∩ B) ∪ C' } }, 'Venn 3', '⊛'], ['truth', {}, 'Truth table', '⊤'], ['truth', { props: { formula: '~(P & Q) <-> ~P | ~Q' } }, 'De Morgan', '¬'],
      ['math', { props: { tex: '\\forall x \\, (P(x) \\to Q(x))' } }, 'Quantifier', '∀'], ['math', { props: { tex: 'A \\cup B = \\{ x \\mid x \\in A \\lor x \\in B \\}' } }, 'Set builder', '∪'],
      ['math', { props: { tex: '\\Box P \\to \\Diamond P' } }, 'Modal', '□'], ['math', { props: { tex: 'P \\to Q,\\; P \\vdash Q' } }, 'Sequent', '⊢']] },
    nodes: { label: 'Nodes', icon: '⋰', items: [['net', {}, 'Ring', '◯'], ['net', { props: { layout: 'complete', n: 6, motion: 'breathe' } }, 'Complete K₆', '✳'], ['net', { props: { layout: 'star', n: 8, nodec: 'GOLD' } }, 'Star', '✶'],
      ['net', { props: { layout: 'tree', n: 15, motion: 'none', nodec: 'GREEN', node: 0.14 } }, 'Tree', '⊥'], ['net', { props: { layout: 'grid', n: 16, motion: 'wave', node: 0.12, nodec: 'TEAL' } }, 'Grid', '#'],
      ['net', { props: { layout: 'random', n: 12, nodec: 'PINK', node: 0.13 } }, 'Random', '⁘'], ['net', { props: { layout: 'petersen', nodec: 'PURPLE', motion: 'rotate' } }, 'Petersen', '⬠'],
      ['net', { props: { layout: 'ring', n: 6, directed: true, curved: true, labels: 'abc', nodec: 'YELLOW', motion: 'none' } }, 'Directed', '↻'], ['net', { props: { layout: 'wheel', n: 9, labels: 'num', node: 0.2, motion: 'jitter', speed: 0.5 } }, 'Wheel', '⊛']] },
    geometry: { label: 'Geometry', icon: '∞', items: [['curve', {}, 'Lissajous', '∞'], ['curve', { props: { shape: 'rose', k: 5, color: 'PINK' } }, 'Rose', '✿'], ['curve', { props: { shape: 'spiral', color: 'GOLD' } }, 'Spiral', '@'],
      ['curve', { props: { shape: 'heart', color: 'RED' } }, 'Heart', '♡'], ['curve', { props: { shape: 'butterfly', color: 'PURPLE' } }, 'Butterfly', 'ʚɞ'], ['curve', { props: { shape: 'spiro', color: 'GREEN' } }, 'Spirograph', '❁'],
      ['curve', { props: { shape: 'epicycloid', k: 4, color: 'YELLOW' } }, 'Epicycloid', '✧'], ['curve', { props: { shape: 'custom' } }, 'x(t), y(t)', 'ƒ'],
      ['fractal', {}, 'Koch snowflake', '❄'], ['fractal', { props: { kind: 'sierpinski', depth: 5, color: 'YELLOW' } }, 'Sierpiński', '△'], ['fractal', { props: { kind: 'tree', depth: 8, color: 'GREEN' } }, 'Fractal tree', 'Y'],
      ['fractal', { props: { kind: 'dragon', depth: 8, color: 'ORANGE' } }, 'Dragon', '⌇'], ['fractal', { props: { kind: 'hilbert', depth: 4, color: 'TEAL' } }, 'Hilbert', '⊓'], ['fractal', { props: { kind: 'carpet', depth: 3, color: 'PURPLE' } }, 'Carpet', '▦']] },
    solids: { label: '3D', icon: '⬢', items: [['solid', { props: { shape: 'cube' } }, 'Cube', '◫'], ['solid', { props: { shape: 'tetrahedron', color: 'GOLD' } }, 'Tetrahedron', '△'], ['solid', { props: { shape: 'octahedron', color: 'GREEN' } }, 'Octahedron', '◇'],
      ['solid', {}, 'Icosahedron', '⬡'], ['solid', { props: { shape: 'dodecahedron', color: 'PURPLE' } }, 'Dodecahedron', '⬠'], ['solid', { props: { shape: 'sphere', style: 'wire', color: 'BLUE', tilt: 10 } }, 'Sphere', '◍'],
      ['solid', { props: { shape: 'torus', color: 'PINK', pitch: 55 } }, 'Torus', '◎'], ['solid', { props: { shape: 'cylinder', color: 'TEAL' } }, 'Cylinder', '▯'], ['solid', { props: { shape: 'cone', color: 'ORANGE' } }, 'Cone', '▲'],
      ['solid', { props: { shape: 'pyramid', color: 'YELLOW' } }, 'Pyramid', '⏶'], ['solid', { props: { shape: 'prism', color: 'RED' } }, 'Prism', '⧋']] },
    stickers: { label: 'Stickers', icon: '★', items: ['star', 'heart', 'check', 'cross', 'bulb', 'speech', 'thought', 'sparkle', 'arrow', 'question', 'exclaim', 'pin', 'brain'].map(k => ['sticker', { props: { kind: k } }, k[0].toUpperCase() + k.slice(1), { star: '★', heart: '♥', check: '✓', cross: '✕', bulb: '◍', speech: '❝', thought: '◌', sparkle: '✦', arrow: '➜', question: '?', exclaim: '!', pin: '⌖', brain: '❦' }[k]]) }
  };
  function addObj(type, over) {
    if (playing) setPlaying(false);
    const o = makeObj(type, clone(over || {}));
    const m = /\[\[\s*([A-Za-z]\w*)/.exec(JSON.stringify(o.props));
    if (m && !A.RESERVED.includes(m[1])) ensureVar(m[1]);
    if (o.end > scene.duration) scene.duration = Math.ceil(o.end);
    scene.objects.push(o);
    commit(); sel = o.id; renderTools(); renderTimeline(); dirty = true;
    openSheet('edit');
  }

  // ---------- toolbar ----------
  function tool(icon, label, fn, cls, id) { return h('button', { type: 'button', class: 'tool ' + (cls || ''), onclick: fn, id: id || null }, h('span', { class: 'ti' }, icon), h('span', { class: 'tlab' }, label)); }
  function renderTools() {
    const bar = $('#tools'); bar.textContent = '';
    if (drw) { renderDrawTools(bar); return; }
    const o = selObj();
    if (!o) {
      bar.append(tool('✒', 'Draw', () => startDraw()));
      for (const [k, c] of Object.entries(CATS)) bar.append(tool(c.icon, c.label, () => openSheet('add:' + k), sheetKind === 'add:' + k ? 'active' : ''));
      bar.append(tool('▨', 'Media', () => openSheet('media'), sheetKind === 'media' ? 'active' : ''));
      bar.append(tool('❖', 'Library', () => openSheet('library'), sheetKind === 'library' ? 'active' : ''));
      bar.append(tool('#', 'Values', () => openSheet('values'), sheetKind === 'values' ? 'active' : ''));
      bar.append(tool('⌖', 'Camera', () => openSheet('camera'), sheetKind === 'camera' ? 'active' : ''));
      bar.append(tool('♪', 'Sound', () => scene.audio ? openSheet('audio') : importSound(), sheetKind === 'audio' ? 'active' : ''));
      bar.append(tool('▣', 'Scene', () => openSheet('scene'), sheetKind === 'scene' ? 'active' : ''));
      bar.append(tool('</>', 'Code', () => openSheet('code'), sheetKind === 'code' ? 'active' : ''));
    } else {
      bar.append(tool('‹', 'Done', () => select(null), 'back'));
      bar.append(tool('✎', 'Edit', () => openSheet('edit'), sheetKind === 'edit' ? 'active' : ''));
      if (o.type === 'vector') bar.append(tool('✒', 'Edit drawing', () => startDraw(o)));
      bar.append(tool('◐', 'Animate', () => { if (animTab === 'effects') animTab = 'in'; openSheet('animate'); }, sheetKind === 'animate' && animTab !== 'effects' ? 'active' : ''));
      bar.append(tool('✺', 'Effects', () => { animTab = 'effects'; openSheet('animate'); }, sheetKind === 'animate' && animTab === 'effects' ? 'active' : ''));
      bar.append(tool('☀', 'Style', () => openSheet('style'), sheetKind === 'style' ? 'active' : ''));
      bar.append(tool('◆', 'Keyframe', toggleAllKeys, keyHere(o) ? 'on' : '', 'keyBtn'));
      bar.append(tool('⤨', 'Position', () => openSheet('position'), sheetKind === 'position' ? 'active' : ''));
      bar.append(tool('⛓', 'Rig', () => openSheet('rig'), sheetKind === 'rig' ? 'active' : ''));
      bar.append(tool('❖', 'Save', () => saveToLibrary(o)));
      bar.append(tool('⧉', 'Copy', dup));
      bar.append(tool('⇡', 'Forward', () => move(1)));
      bar.append(tool('⇣', 'Back', () => move(-1)));
      bar.append(tool('⌫', 'Delete', del, 'danger'));
    }
  }

  // ---------- sheets ----------
  function openSheet(kind) {
    sheetKind = kind;
    document.body.classList.add('sheet-open');
    $('#sheet').hidden = false;
    renderSheet(); renderTools();
    if (!narrow()) sizeStage();
  }
  function closeSheet() {
    sheetKind = null;
    document.body.classList.remove('sheet-open');
    $('#sheet').hidden = true;
    if (scene) { renderTools(); if (!narrow()) sizeStage(); }
  }
  function refreshSheet() { if (sheetKind) renderSheet(); }
  function renderSheet() {
    const body = $('#sheetBody'); const title = $('#sheetTitle');
    previews.clear();
    const keepScroll = body.scrollTop;
    body.textContent = '';
    const k = sheetKind || '';
    const o = selObj();
    if (k.startsWith('add:')) {
      const c = CATS[k.slice(4)];
      title.textContent = 'Add ' + c.label.toLowerCase();
      const g = h('div', { class: 'addgrid' });
      for (const [type, over, label, icon] of c.items) g.append(h('button', { type: 'button', class: 'addbtn', onclick: () => addObj(type, over) }, h('span', { class: 'ic' }, icon), h('span', {}, label)));
      body.append(g, h('p', { class: 'muted small' }, 'It’s added at the playhead (' + fmtT(time) + ') for 4 seconds. Drag it on the preview to place it.'));
    } else if (k === 'scene') { title.textContent = 'Scene'; sceneSheet(body); }
    else if (k === 'drawstyle') { title.textContent = 'Line & fill'; drawStyleSheet(body); }
    else if (k === 'media') { title.textContent = 'Images & sound'; mediaSheet(body); }
    else if (k === 'library') { title.textContent = 'Your library'; librarySheet(body); }
    else if (k === 'values') { title.textContent = 'Live values'; valuesSheet(body); }
    else if (k === 'camera') { title.textContent = 'Camera'; cameraSheet(body); }
    else if (k === 'audio') { title.textContent = 'Sound & markers'; audioSheet(body); }
    else if (k === 'code') { title.textContent = 'Manim code'; codeSheet(body); }
    else if (k === 'ease') { title.textContent = 'Easing curve'; easeSheet(body); }
    else if (!o) { closeSheet(); return; }
    else if (k === 'edit') { title.textContent = o.name; editSheet(body, o); }
    else if (k === 'position') { title.textContent = 'Position & keyframes'; positionSheet(body, o); }
    else if (k === 'animate') { title.textContent = 'Animate'; animateSheet(body, o); }
    else if (k === 'style') { title.textContent = 'Style'; styleSheet(body, o); }
    else if (k === 'rig') { title.textContent = 'Rig, group & follow'; rigSheet(body, o); }
    body.scrollTop = keepScroll;
  }
  $('#sheetClose').addEventListener('click', closeSheet);

  // form helpers
  function colorField(val, onset, allowBlank) {
    const wrap = h('div', { class: 'swatches' });
    const cur = A.color(val) || '';
    const inp = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#ffffff', title: 'Custom colour', 'aria-label': 'Custom colour' });
    inp.addEventListener('input', () => { onset(inp.value.toUpperCase()); mark(inp.value.toUpperCase()); });
    function mark(v) { wrap.querySelectorAll('.sw').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v || (v && A.color(b.dataset.v) === A.color(v)))); }
    if (allowBlank) wrap.append(h('button', { type: 'button', class: 'sw blank', 'data-v': '', title: 'Default', onclick: () => { onset(''); mark(''); } }, '∅'));
    for (const s of SWATCH) wrap.append(h('button', { type: 'button', class: 'sw', 'data-v': s, title: s.toLowerCase(), 'aria-label': s.toLowerCase(), style: 'background:' + A.color(s), onclick: () => { onset(s); mark(s); } }));
    wrap.append(inp);
    mark(val || '');
    return wrap;
  }
  const field = (label, control) => h('label', { class: 'fld' }, h('span', { class: 'fl' }, label), control);
  function numInput(v, step, on, id) {
    const i = h('input', { type: 'number', step: step || 0.1, value: v, inputmode: 'decimal', id: id || null });
    i.addEventListener('input', () => { const n = parseFloat(i.value); if (isFinite(n)) on(n); });
    return i;
  }
  function selectInput(opts, v, on) {
    const s = h('select', { onchange: () => on(s.value) }, opts.map(([k, l]) => h('option', { value: k }, l)));
    s.value = v; return s;
  }
  function stepper(v, step, on) {
    const i = numInput(v, step, on);
    const bump = d => { const n = round((parseFloat(i.value) || 0) + d, 3); i.value = n; on(n); };
    return h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': 'Decrease', onclick: () => bump(-step) }, '−'), i, h('button', { type: 'button', 'aria-label': 'Increase', onclick: () => bump(step) }, '+'));
  }
  const group = (title, ...kids) => h('section', { class: 'grp' }, title ? h('h3', {}, title) : null, ...kids);

  function editSheet(body, o) {
    const T = A.TYPES[o.type];
    const P = Object.assign({}, T.defaults, o.props);
    const changed = tl => { dirty = true; commitSoon(); if (tl) renderTimeline(); };
    const name = h('input', { type: 'text', value: o.name, 'aria-label': 'Name' });
    name.addEventListener('input', () => { o.name = name.value; $('#sheetTitle').textContent = o.name; changed(true); });
    body.append(field('Name', name));
    const err = h('div', { class: 'err', hidden: true });
    function validate() {
      let msg = '';
      try {
        if (o.type === 'graph') { A.compileFn(o.props.f1 ?? P.f1); A.compileFn(o.props.f2 ?? P.f2); }
        if (o.type === 'venn') A.parseSet(o.props.shade ?? P.shade);
        if (o.type === 'truth') A.parseLogic(o.props.formula ?? P.formula);
      } catch (e) { msg = e.message; }
      err.hidden = !msg; err.textContent = msg;
    }
    const conditional = T.fields.some(f => f[4]);
    for (const [key, label, kind, opt, when] of T.fields) {
      if (when && !when(P)) continue;
      const set = v => { o.props[key] = v; changed(); if (conditional) setTimeout(refreshSheetIfNotTyping, 0); };
      let c;
      if (kind === 'textarea' || kind === 'text') {
        c = h(kind === 'textarea' ? 'textarea' : 'input', kind === 'textarea' ? { rows: 2, spellcheck: 'false', autocapitalize: 'off' } : { type: 'text', spellcheck: 'false', autocapitalize: 'off' });
        c.value = P[key];
        c.addEventListener('input', () => { o.props[key] = c.value; changed(); validate(); });
        if (key === 'tex' || (o.type === 'text' && key === 'text')) { body.append(field(label, c), texKeys(c, v => { o.props[key] = v; changed(); })); continue; }
      }
      else if (kind === 'num') c = stepper(P[key], opt, set);
      else if (kind === 'select') c = selectInput(opt.map(x => [String(x[0]), x[1]]), String(P[key]), v => set(isNaN(+v) || v === '' ? v : +v));
      else if (kind === 'bool') { c = h('input', { type: 'checkbox' }); c.checked = !!P[key]; c.addEventListener('change', () => set(c.checked)); body.append(h('label', { class: 'chk' }, c, h('span', {}, label))); continue; }
      else if (kind === 'color') c = colorField(P[key], set, key === 'fill' && o.type === 'sticker');
      body.append(field(label, c));
    }
    body.append(err); validate();
    if (o.type === 'math') body.append(h('p', { class: 'muted small' }, 'LaTeX: \\frac{a}{b}, \\sqrt{x}, x^2, x_i, \\sum_{n=1}^{\\infty}, \\int_a^b, \\alpha … \\omega, \\forall \\exists \\land \\lor \\neg \\to \\vdash \\models, \\in \\cup \\cap \\subseteq \\emptyset, \\mathbb{R}, \\color{BLUE}{x}, \\text{words}. Use \\\\ for a new line and & to line equations up.'));
    if (o.type === 'text') body.append(h('p', { class: 'muted small' }, 'Put maths between dollar signs: The area is $\\pi r^2$.'));
    body.append(group('On screen', h('div', { class: 'two' },
      field('From (s)', numInput(o.start, 0.1, v => { o.start = Math.max(0, Math.min(v, o.end - 0.1)); changed(true); })),
      field('To (s)', numInput(o.end, 0.1, v => { o.end = Math.max(v, o.start + 0.1); if (o.end > scene.duration) scene.duration = Math.ceil(o.end); changed(true); })))));
  }
  function refreshSheetIfNotTyping() { const a = document.activeElement; if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text'))) return; refreshSheet(); }
  // quick-insert keys for LaTeX on a phone keyboard
  function texKeys(ta, onv) {
    const keys = [['\\', '\\'], ['{ }', '{}', 1], ['^', '^{}', 1], ['_', '_{}', 1], ['frac', '\\frac{}{}', 6], ['√', '\\sqrt{}', 1], ['∑', '\\sum_{}^{}', 4], ['∫', '\\int_{}^{}', 4], ['α', '\\alpha '], ['π', '\\pi '], ['θ', '\\theta '],
      ['∀', '\\forall '], ['∃', '\\exists '], ['∧', '\\land '], ['∨', '\\lor '], ['¬', '\\neg '], ['→', '\\to '], ['↔', '\\leftrightarrow '], ['⊢', '\\vdash '], ['∈', '\\in '], ['∪', '\\cup '], ['∩', '\\cap '], ['⊆', '\\subseteq '], ['∅', '\\emptyset '], ['ℝ', '\\mathbb{R}'], ['≤', '\\leq '], ['≠', '\\neq '], ['×', '\\times '], ['$', '$$', 1]];
    const bar = h('div', { class: 'texkeys' });
    for (const [lab, ins, back] of keys) bar.append(h('button', { type: 'button', onpointerdown: e => e.preventDefault(), onclick: () => {
      const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
      ta.value = ta.value.slice(0, a) + ins + ta.value.slice(b);
      const p = a + ins.length - (back || 0);
      ta.focus(); ta.setSelectionRange(p, p); onv(ta.value);
    } }, lab));
    return bar;
  }
  function positionSheet(body, o) {
    const props = [['x', 'Across (x)', 0.25], ['y', 'Up (y)', 0.25], ['scale', 'Size', 0.1], ['sx', 'Stretch wide', 0.1], ['sy', 'Stretch tall', 0.1], ['rotation', 'Rotation (°)', 15], ['opacity', 'Opacity', 0.1]];
    body.append(h('p', { class: 'muted small' }, 'On the preview: drag a corner to resize, a side bar to stretch one way (drag past the middle to mirror it), and the round handle to rotate (it clicks to every 15°).'));
    body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => { for (const [p, v] of [['scale', 1], ['sx', 1], ['sy', 1], ['rotation', 0]]) setProp(o, p, v); commit(); refreshSheet(); dirty = true; } }, 'Reset size & rotation'),
      h('button', { type: 'button', class: 'btn', onclick: () => { setProp(o, 'sx', -A.keyVal(o, 'sx', time)); commit(); refreshSheet(); dirty = true; } }, '⇋ Mirror'),
      h('button', { type: 'button', class: 'btn', onclick: () => { setProp(o, 'sy', -A.keyVal(o, 'sy', time)); commit(); refreshSheet(); dirty = true; } }, '⇵ Flip')));
    for (const [p, label, step] of props) {
      const k = o.keys[p] || [];
      const here = k.some(q => Math.abs(q.t - time) < 0.026);
      const kb = h('button', { type: 'button', class: 'keybtn' + (here ? ' on' : k.length ? ' some' : ''), title: here ? 'Remove keyframe here' : 'Add keyframe here', 'aria-label': (here ? 'Remove ' : 'Add ') + label + ' keyframe', onclick: () => toggleKey(o, p) }, here ? '◆' : '◇');
      const st = stepper(round(A.keyVal(o, p, time), 2), step, v => { setProp(o, p, v); dirty = true; commitSoon(); if (k.length) renderTimelineSoon(); });
      st.querySelector('input').dataset.prop = p;
      body.append(h('div', { class: 'kfrow' }, h('span', { class: 'fl' }, label), st, kb));
    }
    const kt = [...new Set(Object.values(o.keys).flat().map(q => q.t))].sort((a, b) => a - b);
    if (kt.length) {
      body.append(h('div', { class: 'kchips' }, kt.map(t => h('span', { class: 'kpair' }, h('button', { type: 'button', class: 'chip', onclick: () => setTime(t) }, '◆ ' + fmtT(t)),
          h('button', { type: 'button', class: 'chip ease', title: 'Easing into this keyframe', 'aria-label': 'Easing into the keyframe at ' + fmtT(t), onclick: () => openEase({ kind: 'key', id: o.id, t }) }, '⌇'))),
        h('button', { type: 'button', class: 'chip quiet', onclick: () => { o.keys = {}; commit(); refreshSheet(); renderTimeline(); dirty = true; } }, 'Clear all')));
      body.append(h('p', { class: 'muted small' }, 'A property with keyframes animates between them. Changing it, or dragging the object, sets a keyframe at the playhead.'));
    } else body.append(h('p', { class: 'muted small' }, 'To animate movement: tap ◆ Keyframe in the toolbar, move the playhead along the timeline, then drag the object to its new place. Tap ◇ here to keyframe one property only.'));
    const drv = o.drive || {};
    body.append(group('Drive with a formula',
      h('p', { class: 'muted small' }, 'Uses your live values (Values), t = seconds and u = 0 → 1 through the clip. For example 2*sin(3t), a*45 or 1 + u. Leave blank to use keyframes.'),
      ...[['x', 'Across (x)'], ['y', 'Up (y)'], ['rotation', 'Rotation (°)'], ['scale', 'Size'], ['opacity', 'Opacity']].map(([p, l]) => {
        const i = h('input', { type: 'text', value: drv[p] || '', placeholder: '—', spellcheck: 'false', autocapitalize: 'off', 'aria-label': l + ' formula' });
        const out = h('span', { class: 'muted small fval' });
        const show = () => { const v = (o.drive || {})[p]; if (!v) { out.textContent = ''; return; } const r = A.evalExpr(v, Object.assign(A.varsAt(scene, time), { t: time, u: Math.max(0, Math.min(1, (time - o.start) / (o.end - o.start || 1))) })); out.textContent = isFinite(r) ? '= ' + round(r, 3) : '?'; out.classList.toggle('bad', !isFinite(r)); };
        i.addEventListener('input', () => { const v = i.value.trim(); if (!o.drive) o.drive = {}; if (v) o.drive[p] = v; else delete o.drive[p]; if (!Object.keys(o.drive).length) delete o.drive; show(); dirty = true; commitSoon(); });
        show();
        return h('div', { class: 'kfrow' }, h('span', { class: 'fl' }, l), i, out);
      })));
    body.append(h('label', { class: 'chk' }, (() => { const c = h('input', { type: 'checkbox' }); c.checked = guides; c.addEventListener('change', () => { guides = c.checked; $('#guides').setAttribute('aria-pressed', guides); dirty = true; }); return c; })(), h('span', {}, 'Show the coordinate grid and snap to quarter units')));
  }
  const RATES = [['smooth', 'Smooth'], ['linear', 'Linear'], ['easeIn', 'Ease in'], ['easeOut', 'Ease out'], ['backOut', 'Overshoot'], ['bounce', 'Bounce'], ['elastic', 'Elastic'], ['spring', 'Spring'], ['gravity', 'Gravity'], ['snap', 'Snap']];
  // ---------- animation presets with live preview tiles ----------
  let animTab = 'in';
  const previews = new Map();
  let pvRaf = 0, pvLast = 0;
  function miniScene(o, tab, k) {
    const m = clone(o);
    Object.assign(m, { id: 'pv', x: 0, y: 0, keys: {}, emph: [], loop: 'none', rotation: 0, opacity: 1, sx: 1, sy: 1, scale: 1 });
    delete m.parent; delete m.attach; delete m.path; delete m.drive;
    const kids = descendants(o).map(c => Object.assign(clone(c), { start: -10, end: 1e6, anIn: { type: 'appear', dur: 0 }, anOut: { type: 'none', dur: 0 }, emph: [], parent: c.parent === o.id ? 'pv' : c.parent }));
    if (o.type === 'group') { const b = o._hit ? o._hit.bb : [-2, -2, 2, 2]; const bw = (b[2] - b[0]) || 1, bh = (b[3] - b[1]) || 1; m.scale = Math.min(8.4 / bw, 5.2 / bh, 2); }
    else { const b = A.build(m), bw = (b.bb[2] - b.bb[0]) || 1, bh = (b.bb[3] - b.bb[1]) || 1; m.scale = Math.min(8.4 / bw, 5.2 / bh, 2.5); }
    let cycle = 2;
    if (tab === 'in') Object.assign(m, { start: 0, end: 999, anIn: { type: k, dur: 1, rate: k === 'write' ? 'linear' : 'smooth' }, anOut: { type: 'none', dur: 0 } });
    else if (tab === 'out') { Object.assign(m, { start: -10, end: 1.3, anIn: { type: 'appear', dur: 0 }, anOut: { type: MORPH(k) ? 'fadeout' : k, dur: 1 } }); cycle = 2.2; }
    else if (tab === 'loop') Object.assign(m, { start: 0, end: 1e6, anIn: { type: 'appear', dur: 0 }, anOut: { type: 'none', dur: 0 }, loop: k });
    else { Object.assign(m, { start: -10, end: 1e6, anIn: { type: 'appear', dur: 0 }, anOut: { type: 'none', dur: 0 }, emph: [{ type: k, t: 0.25, dur: 1.2 }] }); cycle = 1.9; }
    return { scene: { bg: '#000', duration: 1e6, objects: [m, ...kids], vars: scene.vars }, cycle, tab };
  }
  function pvLoop(now) {
    pvRaf = 0;
    if (!previews.size || sheetKind !== 'animate') return;
    if (now - pvLast > 33) {
      pvLast = now;
      const tt = now / 1000, vh = innerHeight;
      for (const [c, d] of previews) {
        if (!c.isConnected) { previews.delete(c); continue; }
        const r = c.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) continue;
        const t = d.tab === 'loop' ? tt : tt % d.cycle;
        A.render(c.getContext('2d'), d.scene, t, c.width, c.height);
      }
    }
    pvRaf = requestAnimationFrame(pvLoop);
  }
  function animateSheet(body, o) {
    const changed = tl => { dirty = true; commitSoon(); if (tl) renderTimeline(); };
    const rates = RATES.concat(String(o.anIn.rate).startsWith('cb:') || String(o.anOut.rate).startsWith('cb:') ? [['cb', 'Custom curve']] : []);
    const rateSel = (an, which) => h('div', { class: 'row tight' }, selectInput(rates, String(an.rate || 'smooth').startsWith('cb:') ? 'cb' : (an.rate || 'smooth'), v => { if (v !== 'cb') { an.rate = v; changed(); } }),
      h('button', { type: 'button', class: 'btn small', onclick: () => openEase({ kind: which }) }, '⌇ Curve'));
    body.append(h('div', { class: 'tabs', role: 'tablist' }, [['in', 'In'], ['out', 'Out'], ['loop', 'Loop'], ['effects', 'Effects']].map(([k, l]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': animTab === k, class: 'tab' + (animTab === k ? ' on' : ''), onclick: () => { animTab = k; refreshSheet(); renderTools(); } }, l))));
    const list = animTab === 'in' ? A.ANIM_IN : animTab === 'out' ? A.ANIM_OUT : animTab === 'loop' ? A.LOOPS : A.EMPH;
    const cur = animTab === 'in' ? o.anIn.type : animTab === 'out' ? o.anOut.type : animTab === 'loop' ? (o.loop || 'none') : null;
    const others = scene.objects.filter(x => x !== o);
    const pick = k => {
      if (animTab === 'in') { o.anIn.type = k; changed(true); refreshSheet(); previewRange(o.start, o.start + Math.max(o.anIn.dur, 0.6) + 0.4); }
      else if (animTab === 'out') {
        o.anOut.type = k;
        if (MORPH(k) && !o.anOut.target) { const t = others.find(x => x.start >= o.end - 0.3) || others[0]; if (t) linkTransform(o, t); }
        changed(true); refreshSheet(); previewRange(Math.max(0, o.end - o.anOut.dur - 0.4), o.end + 0.3);
      } else if (animTab === 'loop') { o.loop = k; changed(); refreshSheet(); if (k !== 'none') previewRange(Math.max(o.start, time), Math.max(o.start, time) + 2.5); }
      else { const t = Math.max(o.start + (o.anIn.dur || 0), Math.min(time, o.end - 1.2)); o.emph.push({ type: k, t: round(t, 2), dur: 1.2 }); commit(); refreshSheet(); renderTimeline(); dirty = true; previewRange(t - 0.2, t + 1.4); }
    };
    if (animTab === 'effects') body.append(h('p', { class: 'muted small' }, 'Tap an effect to add it at the playhead. It shows as a yellow mark on the clip, which you can drag.'));
    for (const g of [...new Set(list.map(x => x[2]))]) {
      body.append(h('div', { class: 'glab' }, g));
      const grid = h('div', { class: 'animgrid' });
      for (const [k, l] of list.filter(x => x[2] === g)) {
        const c = h('canvas', { class: 'apv', width: 192, height: 128, 'aria-hidden': 'true' });
        grid.append(h('button', { type: 'button', class: 'atile' + (k === cur ? ' on' : ''), 'aria-pressed': k === cur, onclick: () => pick(k) }, c, h('span', {}, l)));
        if (!(animTab === 'out' && MORPH(k)) && k !== 'none' && k !== 'appear') previews.set(c, miniScene(o, animTab, k));
        else { const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 192, 128); x.fillStyle = '#666'; x.font = '40px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(MORPH(k) ? (k === 'transform' ? '⇢' : '⇢≡') : '∅', 96, 64); }
      }
      body.append(grid);
    }
    if (!pvRaf) pvRaf = requestAnimationFrame(pvLoop);
    if (animTab === 'in') body.append(group('Timing', h('div', { class: 'two' }, field('Seconds', stepper(o.anIn.dur, 0.25, v => { o.anIn.dur = Math.max(0.05, v); changed(true); })), field('Easing', rateSel(o.anIn, 'in')))));
    if (animTab === 'out') {
      const kids = [h('div', { class: 'two' }, field('Seconds', stepper(o.anOut.dur, 0.25, v => { o.anOut.dur = Math.max(0.05, v); changed(true); })), field('Easing', rateSel(o.anOut, 'out')))];
      if (MORPH(o.anOut.type)) {
        kids.push(field(o.anOut.type === 'transform' ? 'Transform into' : 'Match symbols into', selectInput([['', '— choose —'], ...others.map(x => [x.id, x.name])], o.anOut.target || '', v => { const t = scene.objects.find(x => x.id === v); if (t) linkTransform(o, t); else o.anOut.target = ''; changed(true); })));
        kids.push(h('p', { class: 'muted small' }, o.anOut.type === 'transform' ? 'Morphs this into the chosen object, like Manim’s Transform. That object is moved to start as this one ends.' : 'Like Manim’s TransformMatchingTex: symbols the two have in common glide to their new places, the rest fade out and in. Best between two equations.'));
      }
      body.append(group('Timing', ...kids));
    }
    if (animTab === 'effects' && (o.emph || []).length) {
      body.append(group('On this clip', ...(o.emph || []).map((e, i) => h('div', { class: 'emrow' },
        selectInput(A.EMPH.map(x => [x[0], x[1]]), e.type, v => { e.type = v; commitSoon(); renderTimeline(); dirty = true; }),
        h('label', { class: 'mini' }, 'at (s)', numInput(e.t, 0.1, v => { e.t = v; commitSoon(); renderTimeline(); dirty = true; })),
        h('label', { class: 'mini' }, 'for (s)', numInput(e.dur, 0.1, v => { e.dur = Math.max(0.1, v); commitSoon(); renderTimeline(); dirty = true; })),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Play this effect', onclick: () => previewRange(e.t - 0.2, e.t + e.dur + 0.2) }, '▶'),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Remove effect', onclick: () => { o.emph.splice(i, 1); commit(); refreshSheet(); renderTimeline(); dirty = true; } }, '✕')))));
    }
  }
  function styleSheet(body, o) {
    const set = (k, v) => { o[k] = v; dirty = true; commitSoon(); };
    const cur = o.style || {};
    const setS = (k, v) => { const s = o.style || (o.style = {}); if (v === '' || v == null || v === 'none' || v === 0) delete s[k]; else s[k] = v; if (!Object.keys(s).length) delete o.style; dirty = true; commitSoon(); };
    const chips = (opts, v, on) => h('div', { class: 'chips' }, opts.map(([k, l]) => h('button', { type: 'button', class: 'pick' + ((v || 'none') === k ? ' on' : ''), onclick: () => { on(k); refreshSheet(); } }, l)));
    body.append(group('Lines',
      field('Line style', chips([['none', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']], cur.dash, v => setS('dash', v))),
      field('Arrowheads on open lines', chips([['none', 'None'], ['end', 'End'], ['start', 'Start'], ['both', 'Both']], cur.arrow, v => setS('arrow', v)))));
    body.append(group('Gradient',
      field('Blend each colour into (∅ = no gradient)', colorField(cur.grad || '', v => setS('grad', v), true)),
      field('Direction (°, 0 = left to right)', stepper(cur.gangle || 0, 45, v => setS('gangle', v)))));
    body.append(group('Glow',
      h('p', { class: 'muted small' }, 'Glow lights the object from within. For a pulsing glow use Animate → Loop → Glow pulse, or Effects → Glow.'),
      field('Presets', h('div', { class: 'chips' }, [[0, 'None'], [0.35, 'Soft'], [0.7, 'Neon'], [1.2, 'Blazing']].map(([v, l]) =>
        h('button', { type: 'button', class: 'pick' + (Math.abs((o.glow || 0) - v) < 0.01 ? ' on' : ''), onclick: () => { set('glow', v); refreshSheet(); } }, l)))),
      field('Glow amount', stepper(o.glow || 0, 0.1, v => set('glow', Math.max(0, Math.min(1.5, v))))),
      field('Glow colour (∅ = its own colours)', colorField(o.glowColor || '', v => set('glowColor', v), true))));
    body.append(h('label', { class: 'chk' }, (() => { const c = h('input', { type: 'checkbox' }); c.checked = !!o.hidden; c.addEventListener('change', () => { o.hidden = c.checked || undefined; commit(); renderTimeline(); dirty = true; }); return c; })(),
      h('span', {}, 'Hide in the video (a faint guide here, for example a motion path)')));
  }

  // ---------- rigs, groups, graph riding and motion paths ----------
  function decompose(m) { const sx = Math.hypot(m[0], m[1]) || 1e-9; return { x: m[4], y: m[5], r: Math.atan2(m[1], m[0]), sx }; }
  // re-express an object's placement when it moves from parent space Pold to parent space Pnew (keyframes too)
  function placeUnder(o, Pold, Pnew) {
    const T = MT.mul(MT.inv(Pnew), Pold), d = decompose(T), dr = d.r * 180 / Math.PI;
    const xs = o.keys.x || [], ys = o.keys.y || [];
    if (xs.length || ys.length) {
      const times = [...new Set([...xs, ...ys].map(k => k.t))].sort((a, b) => a - b);
      const ease = (L, t) => (L.find(k => k.t === t) || {}).ease;
      const nx = [], ny = [];
      for (const t of times) { const [a, b] = MT.ap(T, A.keyVal(o, 'x', t), A.keyVal(o, 'y', t)); nx.push({ t, v: round(a, 3), ease: ease(xs, t) }); ny.push({ t, v: round(b, 3), ease: ease(ys, t) }); }
      o.keys.x = nx; o.keys.y = ny;
    } else { const [a, b] = MT.ap(T, o.x || 0, o.y || 0); o.x = round(a, 3); o.y = round(b, 3); }
    if (Math.abs(dr) > 1e-6) { if (o.keys.rotation && o.keys.rotation.length) o.keys.rotation.forEach(k => { k.v = round(k.v + dr, 2); }); else o.rotation = round((o.rotation || 0) + dr, 2); }
    if (Math.abs(d.sx - 1) > 1e-6) { if (o.keys.scale && o.keys.scale.length) o.keys.scale.forEach(k => { k.v = round(k.v * d.sx, 4); }); else o.scale = round((o.scale == null ? 1 : o.scale) * d.sx, 4); }
  }
  const worldOf = id => { const p = objById(id); return p ? A.restWorld(scene, p, time) : MT.I; };
  function reparent(o, pid) {
    const Pold = o.parent ? worldOf(o.parent) : MT.I;
    delete o.attach; delete o.path;
    if (pid) o.parent = pid; else delete o.parent;
    placeUnder(o, Pold, pid ? worldOf(pid) : MT.I);
  }
  function clearRefs(id) {
    scene.objects.forEach(x => {
      if (x.anOut && x.anOut.target === id) { x.anOut.target = ''; if (MORPH(x.anOut.type)) x.anOut.type = 'fadeout'; }
      if (x.parent === id) delete x.parent;
      if (x.attach && x.attach.to === id) delete x.attach;
      if (x.path && x.path.to === id) delete x.path;
    });
  }
  function makeGroup(list) {
    if (list.length < 2) { toast('Pick at least one other object to group with.'); return; }
    const parent = list[0].parent || null, Pp = parent ? worldOf(parent) : MT.I, Pi = MT.inv(Pp);
    let cx = 0, cy = 0;
    list.forEach(m => { const w = A.restWorld(scene, m, time), [x, y] = MT.ap(Pi, w[4], w[5]); cx += x; cy += y; });
    const g = makeObj('group', { name: 'Group ' + (scene.objects.filter(x => x.type === 'group').length + 1), start: Math.min(...list.map(m => m.start)), end: Math.max(...list.map(m => m.end)),
      x: round(cx / list.length, 2), y: round(cy / list.length, 2), anIn: { type: 'appear', dur: 0, rate: 'smooth' }, anOut: { type: 'none', dur: 0, rate: 'smooth' }, loop: 'none' });
    if (parent) g.parent = parent;
    scene.objects.splice(Math.min(...list.map(m => scene.objects.indexOf(m))), 0, g);
    const G = A.restWorld(scene, g, time);
    list.forEach(m => { m.parent = g.id; placeUnder(m, Pp, G); });
    commit(); select(g.id); toast('Grouped ' + list.length + ' objects');
  }
  function ungroup(g) {
    const kids = scene.objects.filter(c => c.parent === g.id), G = A.restWorld(scene, g, time), Pp = g.parent ? worldOf(g.parent) : MT.I;
    kids.forEach(c => { if (g.parent) c.parent = g.parent; else delete c.parent; placeUnder(c, G, Pp); });
    scene.objects = scene.objects.filter(x => x !== g);
    clearRefs(g.id);
    commit(); select(kids[0] ? kids[0].id : null); renderTimeline(); toast('Ungrouped');
  }
  const chk = (label, on, set) => h('label', { class: 'chk' }, (() => { const c = h('input', { type: 'checkbox' }); c.checked = !!on; c.addEventListener('change', () => set(c.checked)); return c; })(), h('span', {}, label));
  function rigSheet(body, o) {
    const others = scene.objects.filter(x => x !== o);
    const desc = new Set(descendants(o).map(x => x.id));
    const upd = () => { commit(); refreshSheet(); renderTimeline(); dirty = true; };
    if (o.type === 'group') {
      const kids = scene.objects.filter(c => c.parent === o.id);
      body.append(group('In this group', h('div', { class: 'chips' }, kids.map(c => h('button', { type: 'button', class: 'pick', onclick: () => select(c.id) }, c.name))),
        h('p', { class: 'muted small' }, 'Moving, sizing, turning or animating the group moves every member. On the preview, the first tap picks the group and a second tap picks the member.'),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => ungroup(o) }, 'Ungroup'))));
    } else {
      const sib = others.filter(x => (x.parent || null) === (o.parent || null) && !desc.has(x.id) && !(x.attach || x.path));
      const picks = new Set();
      body.append(group('Group', sib.length ? h('p', { class: 'muted small' }, 'Pick what to group with “' + o.name + '”, then tap Make group.') : h('p', { class: 'muted small' }, 'Add more objects to group them.'),
        h('div', { class: 'chips' }, sib.map(x => { const b = h('button', { type: 'button', class: 'pick', 'aria-pressed': 'false', onclick: () => { if (picks.has(x.id)) picks.delete(x.id); else picks.add(x.id); b.classList.toggle('on', picks.has(x.id)); b.setAttribute('aria-pressed', picks.has(x.id)); } }, x.name); return b; })),
        sib.length ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => makeGroup([o, ...sib.filter(x => picks.has(x.id))]) }, '⧈ Make group')) : null));
    }
    // parent
    body.append(group('Attach to a parent (rig)',
      h('p', { class: 'muted small' }, 'It then moves, turns and sizes with its parent, like a hand on an arm. Put each part’s pivot at its joint so it bends there.'),
      field('Parent', selectInput([['', '— none —'], ...others.filter(x => !desc.has(x.id)).map(x => [x.id, x.name])], o.parent || '', v => { reparent(o, v || null); upd(); }))));
    // pivot
    const bb = o._hit ? o._hit.bb : A.build(o).bb, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    const PV = [['Centre', cx, cy], ['Top', cx, bb[1]], ['Bottom', cx, bb[3]], ['Left', bb[0], cy], ['Right', bb[2], cy], ['Top left', bb[0], bb[1]], ['Top right', bb[2], bb[1]], ['Bottom left', bb[0], bb[3]], ['Bottom right', bb[2], bb[3]]];
    body.append(group('Pivot',
      h('p', { class: 'muted small' }, 'The point it turns and sizes around. Rigs bend at pivots, and the Pendulum loop swings from it.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn' + (pivotMode ? ' primary' : ''), onclick: () => { pivotMode = !pivotMode; if (!pivotMode) commit(); dirty = true; refreshSheet(); } }, pivotMode ? '✓ Done moving the pivot' : '⊕ Drag the pivot on the preview')),
      h('div', { class: 'chips' }, PV.map(([l, x, y]) => h('button', { type: 'button', class: 'pick', onclick: () => { setPivot(o, [x, -y]); commit(); dirty = true; } }, l)))));
    // graph
    const graphs = others.filter(x => x.type === 'graph'), at = o.attach || {};
    const gk = [h('p', { class: 'muted small' }, 'Sits on a graph’s curve and slides along it, like a dot on Manim’s axes.'),
      field('Graph', selectInput([['', '— not on a graph —'], ...graphs.map(g => [g.id, g.name])], at.to || '', v => {
        if (v) { o.attach = Object.assign({ fn: 1, x: '', tilt: false, ease: 'smooth' }, o.attach || {}, { to: v }); delete o.parent; delete o.path; o.x = 0; o.y = 0; delete o.keys.x; delete o.keys.y; }
        else delete o.attach;
        upd();
      }))];
    if (!graphs.length) gk.push(h('p', { class: 'muted small' }, 'Add a graph first (Graph in the toolbar).'));
    if (o.attach) {
      const xi = h('input', { type: 'text', value: at.x || '', placeholder: 'blank: slides left to right', spellcheck: 'false', autocapitalize: 'off' });
      xi.addEventListener('input', () => { o.attach.x = xi.value.trim(); dirty = true; commitSoon(); });
      gk.push(h('div', { class: 'two' }, field('Curve', selectInput([['1', 'Curve 1'], ['2', 'Curve 2']], String(at.fn || 1), v => { o.attach.fn = +v; dirty = true; commitSoon(); })), field('Slide easing', selectInput(RATES, at.ease || 'smooth', v => { o.attach.ease = v; dirty = true; commitSoon(); }))),
        field('Where along x', xi), h('p', { class: 'muted small' }, 'Blank: it travels along the curve during its clip. Or type a number (2), a live value (a) or a formula (3*sin(t)).'),
        chk('Tilt with the slope', at.tilt, v => { o.attach.tilt = v; dirty = true; commitSoon(); }));
    }
    body.append(group('Ride along a graph', ...gk));
    // path
    const pathy = others.filter(x => ['vector', 'curve', 'shape', 'geom', 'fractal'].includes(x.type) && !desc.has(x.id)), pa = o.path || {};
    const pk = [h('p', { class: 'muted small' }, 'Travels along another object’s outline during its clip. Draw a line with ✒ Draw to make a path.'),
      field('Path', selectInput([['', '— no path —'], ...pathy.map(g => [g.id, g.name])], pa.to || '', v => {
        if (v) { o.path = Object.assign({ ease: 'smooth', orient: false }, o.path || {}, { to: v }); delete o.parent; delete o.attach; o.x = 0; o.y = 0; delete o.keys.x; delete o.keys.y; }
        else delete o.path;
        upd();
      }))];
    if (o.path) {
      const tg = objById(pa.to);
      pk.push(field('Easing', selectInput(RATES, pa.ease || 'smooth', v => { o.path.ease = v; dirty = true; commitSoon(); })),
        chk('Turn to face along the path', pa.orient, v => { o.path.orient = v; dirty = true; commitSoon(); }),
        chk('Go the other way', pa.reverse, v => { o.path.reverse = v; dirty = true; commitSoon(); }),
        tg ? chk('Hide the path in the video', tg.hidden, v => { tg.hidden = v || undefined; commit(); renderTimeline(); dirty = true; }) : null);
    }
    body.append(group('Follow a path', ...pk));
  }

  // ---------- live values ----------
  function renameVar(a, b) {
    const re = new RegExp('\\b' + a + '\\b', 'g');
    const inTpl = s => String(s).replace(/\[\[([^\]]+)\]\]/g, m => m.replace(re, b));
    for (const o of scene.objects) {
      for (const [k, v] of Object.entries(o.props || {})) if (typeof v === 'string') o.props[k] = ['f1', 'f2', 'xt', 'yt'].includes(k) ? v.replace(re, b) : inTpl(v);
      if (o.drive) for (const k in o.drive) o.drive[k] = o.drive[k].replace(re, b);
      if (o.attach && o.attach.x) o.attach.x = String(o.attach.x).replace(re, b);
    }
  }
  function ensureVar(name) {
    if (!scene.vars) scene.vars = [];
    if (scene.vars.some(d => d.name === name)) return;
    const t = round(time, 2);
    scene.vars.push({ name, v: 0, keys: [{ t, v: 0 }, { t: round(t + 3, 2), v: 10 }] });
  }
  const keyBtn = (on, some, label, fn) => h('button', { type: 'button', class: 'keybtn' + (on ? ' on' : some ? ' some' : ''), 'aria-label': (on ? 'Remove ' : 'Add ') + label + ' keyframe', onclick: fn }, on ? '◆' : '◇');
  function keyChips(times, onEase) {
    return h('div', { class: 'kchips' }, times.map(t => h('span', { class: 'kpair' }, h('button', { type: 'button', class: 'chip', onclick: () => setTime(t) }, '◆ ' + fmtT(t)),
      h('button', { type: 'button', class: 'chip ease', 'aria-label': 'Easing into ' + fmtT(t), onclick: () => onEase(t) }, '⌇'))));
  }
  function valuesSheet(body) {
    const V = scene.vars || (scene.vars = []);
    body.append(h('p', { class: 'muted small' }, 'A live value is a number that changes over time, like Manim’s ValueTracker. Show it with [[a]] (or [[a:1]] for one decimal place) in any text or maths, use its name in a graph formula, or drive a position with it (Position → Drive with a formula).'));
    const now = A.varsAt(scene, time);
    V.forEach((d, i) => {
      const k = d.keys || (d.keys = []);
      const t = round(time, 2), here = k.find(q => Math.abs(q.t - t) < 0.026);
      const nm = h('input', { type: 'text', value: d.name, class: 'vname', 'aria-label': 'Name', spellcheck: 'false', autocapitalize: 'off' });
      nm.addEventListener('change', () => {
        const v = nm.value.trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(v) || A.RESERVED.includes(v) || ['t', 'u', 'V'].includes(v) || V.some(x => x !== d && x.name === v)) { toast('Use a short name of letters, like a or speed (not x, t, u, e or a function name).'); nm.value = d.name; return; }
        renameVar(d.name, v); d.name = v; commit(); refreshSheet(); dirty = true;
      });
      const st = stepper(round(now[d.name], 3), d.step || 1, v => {
        if (k.length) { const ex = k.find(q => Math.abs(q.t - round(time, 2)) < 0.026); if (ex) ex.v = v; else { k.push({ t: round(time, 2), v }); k.sort((a, b) => a.t - b.t); } }
        else d.v = v;
        dirty = true; commitSoon();
      });
      const inp = st.querySelector('input'); inp.dataset.live = '1'; inp._get = () => round(A.varsAt(scene, time)[d.name], 3);
      const kb = keyBtn(here, k.length, d.name, () => { const j = k.findIndex(q => Math.abs(q.t - round(time, 2)) < 0.026); if (j >= 0) k.splice(j, 1); else { k.push({ t: round(time, 2), v: A.varsAt(scene, time)[d.name] }); k.sort((a, b) => a.t - b.t); } commit(); refreshSheet(); dirty = true; });
      const box = h('div', { class: 'vbox' }, h('div', { class: 'vrow' }, nm, st, kb, h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Delete ' + d.name, onclick: () => { V.splice(i, 1); commit(); refreshSheet(); dirty = true; } }, '✕')));
      if (k.length) box.append(keyChips(k.map(q => q.t), tt => openEase({ kind: 'key', id: 'var:' + d.name, t: tt })));
      body.append(box);
    });
    const nextName = () => ['a', 'b', 'c', 'k', 'n', 'm', 'p', 'q', 'r', 's', 'w'].find(n => !V.some(d => d.name === n)) || 'v' + (V.length + 1);
    body.append(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => { V.push({ name: nextName(), v: 0, keys: [] }); commit(); refreshSheet(); } }, '＋ New value'),
      h('button', { type: 'button', class: 'btn', onclick: () => { const n = V[0] ? V[0].name : nextName(); ensureVar(n); addObj('math', { name: 'Number ' + n, props: { tex: n + ' = [[' + n + ':1]]' } }); } }, '＋ Show one on screen')));
    if (V.length) body.append(h('p', { class: 'muted small' }, 'To animate a value: tap ◇, move the playhead, then change the number. ⌇ sets how it eases between keyframes.'));
  }

  // ---------- camera ----------
  function camObj() { return scene.camera || (scene.camera = { x: 0, y: 0, zoom: 1, rotation: 0, keys: {} }); }
  function cameraSheet(body) {
    const cam = camObj();
    body.append(h('p', { class: 'muted small' }, 'Pan, zoom and turn the whole view, like Manim’s MovingCameraScene. Keyframe it as you would an object: tap ◇, move the playhead, then change a value.'));
    for (const [p, label, step] of [['x', 'Look at x', 0.5], ['y', 'Look at y', 0.5], ['zoom', 'Zoom', 0.1], ['rotation', 'Turn (°)', 15]]) {
      const k = cam.keys[p] || [], here = k.some(q => Math.abs(q.t - time) < 0.026);
      const st = stepper(round(A.keyVal(cam, p, time), 2), step, v => { setProp(cam, p, p === 'zoom' ? Math.max(0.1, v) : v); dirty = true; commitSoon(); });
      const inp = st.querySelector('input'); inp.dataset.live = '1'; inp._get = () => round(A.keyVal(cam, p, time), 2);
      body.append(h('div', { class: 'kfrow' }, h('span', { class: 'fl' }, label), st, keyBtn(here, k.length, label, () => toggleKey(cam, p))));
    }
    const kt = [...new Set(Object.values(cam.keys).flat().map(q => q.t))].sort((a, b) => a - b);
    if (kt.length) body.append(keyChips(kt, t => openEase({ kind: 'key', id: 'cam', t })));
    const move = (to, dur) => {
      const t = round(time, 2);
      for (const [p, v] of Object.entries(to)) { const k = cam.keys[p] || (cam.keys[p] = []); const v0 = A.keyVal(cam, p, time); [[t, v0], [round(t + dur, 2), v]].forEach(([tt, vv]) => { const ex = k.find(q => Math.abs(q.t - tt) < 0.026); if (ex) ex.v = round(vv, 3); else k.push({ t: tt, v: round(vv, 3) }); }); k.sort((a, b) => a.t - b.t); }
      if (t + dur > scene.duration) scene.duration = Math.ceil(t + dur);
      commit(); refreshSheet(); renderTimeline(); dirty = true; previewRange(t - 0.2, t + dur + 0.3);
    };
    const r = ratio(scene.aspect);
    body.append(group('Moves from the playhead',
      h('div', { class: 'chips' },
        h('button', { type: 'button', class: 'pick', onclick: () => move({ zoom: A.keyVal(cam, 'zoom', time) * 1.6 }, 2) }, 'Push in'),
        h('button', { type: 'button', class: 'pick', onclick: () => move({ zoom: A.keyVal(cam, 'zoom', time) / 1.6 }, 2) }, 'Pull out'),
        h('button', { type: 'button', class: 'pick', onclick: () => move({ x: 0, y: 0, zoom: 1, rotation: 0 }, 1.2) }, 'Back to start'),
        h('button', { type: 'button', class: 'pick', onclick: () => move({ rotation: A.keyVal(cam, 'rotation', time) + 15 }, 1.5) }, 'Tilt')),
      field('Focus on', selectInput([['', '— choose an object —'], ...scene.objects.filter(o => o.type !== 'group' || true).map(o => [o.id, o.name])], '', v => {
        const o = objById(v); if (!o) return;
        const W = A.restWorld(scene, o, Math.max(time, o.start)), bb = o._hit ? o._hit.bb : A.build(o).bb;
        const c = MT.ap(MT.mul(W, MT.FLIP), (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2), s = MT.mdet(W);
        const z = Math.max(0.3, Math.min(6, 0.75 * Math.min(8 / (((bb[3] - bb[1]) * s) || 1), 8 * r / (((bb[2] - bb[0]) * s) || 1))));
        move({ x: c[0], y: c[1], zoom: z }, 1.2);
      })),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => { delete scene.camera; commit(); refreshSheet(); dirty = true; } }, 'Remove all camera moves'))));
  }

  // ---------- sound and markers ----------
  function addMarker() {
    const t = round(time, 2);
    if (!scene.markers) scene.markers = [];
    if (!scene.markers.some(m => Math.abs(m - t) < 0.05)) { scene.markers.push(t); scene.markers.sort((a, b) => a - b); }
    commitSoon(); renderTimelineSoon();
    if (!playing && sheetKind === 'audio') refreshSheet();
    const b = document.getElementById('markBtn'); if (b) { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 150); }
  }
  function audioSheet(body) {
    const au = scene.audio;
    if (au) {
      body.append(h('div', { class: 'row' }, h('b', {}, '♪ ' + au.name), h('span', { class: 'muted small' }, sound.dur ? fmtT(sound.dur) : (sound.el ? '' : 'not on this device'))));
      body.append(h('div', { class: 'two' },
        field('Starts at (s)', stepper(au.offset || 0, 0.1, v => { au.offset = round(v, 2); renderTimelineSoon(); commitSoon(); })),
        field('Volume', stepper(au.vol == null ? 1 : au.vol, 0.1, v => { au.vol = Math.max(0, Math.min(1, round(v, 2))); commitSoon(); }))));
      body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: importSound }, 'Replace sound'),
        h('button', { type: 'button', class: 'btn quiet', onclick: () => { delete scene.audio; commit(); loadMedia(); refreshSheet(); renderTimeline(); } }, 'Remove sound')));
      body.append(h('p', { class: 'muted small' }, 'The sound plays with the preview and is mixed into exported videos. Drag its strip on the timeline to shift it.'));
    } else body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: importSound }, '♪ Add a sound…')), h('p', { class: 'muted small' }, 'Music or a voice-over from your device.'));
    const M = scene.markers || [];
    body.append(group('Markers',
      h('p', { class: 'muted small' }, 'Cues on the timeline, such as beats or words in a voice-over. Clips snap to them as you drag. Play, and tap Marker in time to drop them as you go (or press M).'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', id: 'markBtn', onclick: addMarker }, '◆ Marker at playhead'), h('button', { type: 'button', class: 'btn', onclick: () => setPlaying(!playing) }, playing ? '❚❚ Pause' : '▶ Play')),
      M.length ? h('div', { class: 'kchips' }, M.map((m, i) => h('span', { class: 'kpair' }, h('button', { type: 'button', class: 'chip', onclick: () => setTime(m) }, '▾ ' + fmtT(m)),
        h('button', { type: 'button', class: 'chip ease', 'aria-label': 'Remove marker', onclick: () => { M.splice(i, 1); commit(); refreshSheet(); renderTimeline(); } }, '✕'))),
        h('button', { type: 'button', class: 'chip quiet', onclick: () => { scene.markers = []; commit(); refreshSheet(); renderTimeline(); } }, 'Clear all')) : null));
  }
  function mediaSheet(body) {
    const g = h('div', { class: 'addgrid' });
    g.append(h('button', { type: 'button', class: 'addbtn', onclick: importImage }, h('span', { class: 'ic' }, '▨'), h('span', {}, 'Image…')),
      h('button', { type: 'button', class: 'addbtn', onclick: importSound }, h('span', { class: 'ic' }, '♪'), h('span', {}, scene.audio ? 'Replace sound…' : 'Sound…')));
    body.append(g, h('p', { class: 'muted small' }, 'Images and sound are kept in this app on this device. A saved project file (Projects → Save project file) carries them with it.'));
  }

  // ---------- your library ----------
  let libEdit = false;
  const LIBK = 'animath.library';
  function retime(objs, dt, mapId) {
    objs.forEach(c => {
      c.start = round(c.start + dt, 3); c.end = round(c.end + dt, 3);
      c.emph = (c.emph || []).map(e => Object.assign(e, { t: round(e.t + dt, 3) }));
      for (const k in c.keys || {}) c.keys[k] = c.keys[k].map(q => Object.assign(q, { t: round(q.t + dt, 3) }));
      if (mapId) {
        c.id = mapId(c.id);
        for (const f of ['parent']) if (c[f]) c[f] = mapId(c[f], true);
        if (c.attach) { const m = mapId(c.attach.to, true); if (m) c.attach.to = m; else delete c.attach; }
        if (c.path) { const m = mapId(c.path.to, true); if (m) c.path.to = m; else delete c.path; }
        if (c.anOut && c.anOut.target) { const m = mapId(c.anOut.target, true); if (m) c.anOut.target = m; else { c.anOut.target = ''; if (MORPH(c.anOut.type)) c.anOut.type = 'fadeout'; } }
      }
    });
    return objs;
  }
  function thumbOf(objs) {
    try {
      const c = h('canvas'); c.width = 192; c.height = 128;
      const ctx = c.getContext('2d');
      const sc = { bg: scene.bg, duration: 1e6, objects: clone(objs), vars: scene.vars };
      const t = objs[0].start + A.phases(objs[0]).inD + 0.02;
      A.render(ctx, sc, t, 192, 128);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const o of sc.objects) { const hh = o._hit; if (!hh || hh.group) continue; const PF = MT.mul(hh.P, MT.FLIP), b = hh.bb; for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) { const [a, d] = MT.ap(PF, x, y); x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, d); y1 = Math.max(y1, d); } }
      if (isFinite(x0)) { sc.camera = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom: Math.min(8 * 0.82 / ((y1 - y0) || 1), 12 * 0.82 / ((x1 - x0) || 1), 5), rotation: 0, keys: {} }; A.render(ctx, sc, t, 192, 128); }
      return c.toDataURL('image/jpeg', 0.8);
    } catch (e) { return null; }
  }
  function saveToLibrary(o) {
    const objs = clone([o, ...descendants(o)]);
    delete objs[0].parent; delete objs[0].attach; delete objs[0].path;
    retime(objs, -o.start);
    const lib = store.get(LIBK, []);
    lib.unshift({ id: uid(), name: o.name, objs, thumb: thumbOf(objs), at: Date.now() });
    if (!store.set(LIBK, lib)) { toast('Couldn’t save it: this device’s storage is full.'); return; }
    toast('Saved “' + o.name + '” to your library (❖ Library)');
  }
  function insertAsset(it) {
    if (playing) setPlaying(false);
    const ids = new Map(it.objs.map(c => [c.id, uid()]));
    const objs = retime(clone(it.objs), round(time, 2), (id, ref) => ids.get(id) || (ref ? null : uid()));
    scene.objects.push(...objs);
    const end = Math.max(...objs.map(c => c.end)); if (end > scene.duration) scene.duration = Math.ceil(end);
    commit(); select(objs[0].id); loadMedia(); toast('Added “' + it.name + '”');
  }
  function librarySheet(body) {
    const lib = store.get(LIBK, []);
    if (!lib.length) { body.append(h('p', { class: 'muted' }, 'Nothing saved yet. Select something you made, such as a drawing, a group or a rig, and tap ❖ Save. It then appears here in every project on this device.')); return; }
    const g = h('div', { class: 'addgrid libgrid' });
    lib.forEach((it, i) => g.append(h('div', { class: 'libitem' },
      h('button', { type: 'button', class: 'addbtn', onclick: () => insertAsset(it) }, it.thumb ? h('img', { src: it.thumb, alt: '' }) : h('span', { class: 'ic' }, '❖'), h('span', {}, it.name)),
      libEdit ? h('button', { type: 'button', class: 'iconbtn libdel', 'aria-label': 'Remove ' + it.name, onclick: async () => { if (!await ask('Remove “' + it.name + '” from your library?', 'Remove')) return; const L = store.get(LIBK, []); L.splice(i, 1); store.set(LIBK, L); refreshSheet(); } }, '✕') : null)));
    body.append(g, h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => { libEdit = !libEdit; refreshSheet(); } }, libEdit ? 'Done' : 'Edit')),
      h('p', { class: 'muted small' }, 'Tap one to add it at the playhead, with its animations.'));
  }

  // ---------- Manim code ----------
  function codeSheet(body) {
    let code;
    try { code = window.AnimathCode.generate(scene); } catch (e) { code = '# Couldn’t write the code: ' + e.message; }
    const name = slug().replace(/-/g, '_') + '.py';
    body.append(h('p', { class: 'muted small' }, 'This scene as Python for the Manim Community library, to run on a computer with Manim installed. It’s read-only: change the scene here and the code follows. Shapes Manim lacks become labelled placeholders.'));
    body.append(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', onclick: async () => { try { await navigator.clipboard.writeText(code); toast('Copied'); } catch (e) { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selected: copy it with your keyboard or menu'); } } }, '⧉ Copy'),
      h('button', { type: 'button', class: 'btn', onclick: () => download(name, new Blob([code], { type: 'text/x-python' })) }, '⤓ Save ' + name)));
    const pre = h('pre', { class: 'code' }, h('code', {}, code));
    body.append(pre);
  }

  // ---------- easing curves ----------
  let easeT = null, easeBack = null, easeRaf = 0;
  function openEase(target) { easeT = target; easeBack = sheetKind === 'ease' ? easeBack : sheetKind; openSheet('ease'); }
  function easeKeys() {
    const t = easeT;
    if (t.id === 'cam') return Object.values(camObj().keys).map(k => k.find(q => Math.abs(q.t - t.t) < 0.026)).filter(Boolean);
    if (String(t.id).startsWith('var:')) { const d = (scene.vars || []).find(x => x.name === t.id.slice(4)); return d ? (d.keys || []).filter(q => Math.abs(q.t - t.t) < 0.026) : []; }
    const o = objById(t.id); return o ? Object.values(o.keys || {}).map(k => k.find(q => Math.abs(q.t - t.t) < 0.026)).filter(Boolean) : [];
  }
  function easeGet() {
    if (!easeT) return 'smooth';
    if (easeT.kind === 'in' || easeT.kind === 'out') { const o = selObj(); return o ? (easeT.kind === 'in' ? o.anIn.rate : o.anOut.rate) || 'smooth' : 'smooth'; }
    const k = easeKeys().find(q => q.ease); return (k && k.ease) || 'smooth';
  }
  function easeSet(v) {
    if (!easeT) return;
    if (easeT.kind === 'in' || easeT.kind === 'out') { const o = selObj(); if (o) (easeT.kind === 'in' ? o.anIn : o.anOut).rate = v; }
    else easeKeys().forEach(q => { q.ease = v; });
    dirty = true; commitSoon();
  }
  function curveIcon(c, f, opts) {
    const x = c.getContext('2d'), W = c.width, H = c.height, pad = opts && opts.pad || 8, lo = -0.35, hi = 1.35;
    const Y = v => H - pad - (v - lo) / (hi - lo) * (H - 2 * pad), X = u => pad + u * (W - 2 * pad);
    x.clearRect(0, 0, W, H);
    x.strokeStyle = 'rgba(255,255,255,.18)'; x.lineWidth = 1; x.beginPath(); x.moveTo(X(0), Y(0)); x.lineTo(X(1), Y(0)); x.moveTo(X(0), Y(1)); x.lineTo(X(1), Y(1)); x.stroke();
    x.strokeStyle = '#58C4DD'; x.lineWidth = 2.2; x.beginPath();
    for (let i = 0; i <= 80; i++) { const u = i / 80, v = f(u); i ? x.lineTo(X(u), Y(v)) : x.moveTo(X(u), Y(v)); }
    x.stroke();
    return { X, Y };
  }
  const easeFn = k => k === 'hold' ? (u => u < 1 ? 0 : 1) : A.rateFn(k);
  function easeSheet(body) {
    if (!easeT) { closeSheet(); return; }
    cancelAnimationFrame(easeRaf);
    const cur = easeGet();
    const what = easeT.kind === 'in' ? 'the in animation' : easeT.kind === 'out' ? 'the out animation' : 'the keyframe at ' + fmtT(easeT.t) + (easeT.id === 'cam' ? ' (camera)' : String(easeT.id).startsWith('var:') ? ' (' + easeT.id.slice(4) + ')' : '');
    body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => openSheet(easeBack && easeBack !== 'ease' ? easeBack : 'position') }, '‹ Back'), h('span', { class: 'muted small' }, 'How it moves into ' + what)));
    const g = h('div', { class: 'animgrid easegrid' });
    const list = RATES.concat(easeT.kind === 'key' ? [['hold', 'Hold, then jump']] : []);
    for (const [k, l] of list) {
      const c = h('canvas', { width: 120, height: 80, 'aria-hidden': 'true' });
      curveIcon(c, easeFn(k));
      g.append(h('button', { type: 'button', class: 'atile' + (k === cur ? ' on' : ''), 'aria-pressed': k === cur, onclick: () => { easeSet(k); refreshSheet(); } }, c, h('span', {}, l)));
    }
    body.append(g);
    // cubic-bezier editor
    let cb = String(cur).startsWith('cb:') ? cur.slice(3).split(',').map(Number) : [0.42, 0, 0.58, 1];
    const cv = h('canvas', { class: 'bez', width: 560, height: 420, 'aria-label': 'Drag the two handles to shape the curve' });
    const read = h('p', { class: 'muted small mono' });
    const dot = h('div', { class: 'easedot' }), track = h('div', { class: 'easetrack' }, dot);
    let geo = null;
    const paint = () => {
      const f = A.rateFn('cb:' + cb.join(','));
      geo = curveIcon(cv, f, { pad: 40 });
      const x = cv.getContext('2d'), P = (u, v) => [geo.X(u), geo.Y(v)];
      x.strokeStyle = 'rgba(255,255,0,.7)'; x.lineWidth = 1.5;
      [[0, 0, cb[0], cb[1]], [1, 1, cb[2], cb[3]]].forEach(([a, b, c2, d]) => { x.beginPath(); x.moveTo(...P(a, b)); x.lineTo(...P(c2, d)); x.stroke(); x.fillStyle = '#FFFF00'; x.beginPath(); x.arc(...P(c2, d), 13, 0, 7); x.fill(); });
      read.textContent = 'cubic-bezier(' + cb.map(v => round(v, 2)).join(', ') + ')' + (String(easeGet()).startsWith('cb:') ? '' : ' · drag a handle to use it');
    };
    let drag = -1;
    const pos = e => { const r = cv.getBoundingClientRect(), sx = cv.width / r.width, sy = cv.height / r.height; return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy]; };
    const inv = ([px, py]) => { const u = (px - 40) / (cv.width - 80), v = -0.35 + (cv.height - 40 - py) / (cv.height - 80) * 1.7; return [Math.max(0, Math.min(1, u)), Math.max(-0.6, Math.min(1.6, v))]; };
    cv.addEventListener('pointerdown', e => { const p = pos(e); const d = [[cb[0], cb[1]], [cb[2], cb[3]]].map(([u, v]) => Math.hypot(geo.X(u) - p[0], geo.Y(v) - p[1])); drag = d[0] <= d[1] ? 0 : 1; if (d[drag] > 60) drag = -1; else { cv.setPointerCapture(e.pointerId); e.preventDefault(); } });
    cv.addEventListener('pointermove', e => { if (drag < 0) return; const [u, v] = inv(pos(e)); cb[drag * 2] = round(u, 3); cb[drag * 2 + 1] = round(v, 3); easeSet('cb:' + cb.join(',')); paint(); g.querySelectorAll('.atile').forEach(b => b.classList.remove('on')); });
    const up = () => { if (drag >= 0) { drag = -1; commit(); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    body.append(group('Your own curve', cv, read, track, h('p', { class: 'muted small' }, 'Drag the yellow handles. Above the top line overshoots; below the bottom line pulls back first.')));
    paint();
    const t0 = performance.now();
    const anim = now => { if (sheetKind !== 'ease' || !dot.isConnected) return; const ph = ((now - t0) / 1600) % 1.4, u = Math.min(1, ph); dot.style.left = (easeFn(easeGet())(u) * 100).toFixed(2) + '%'; easeRaf = requestAnimationFrame(anim); };
    easeRaf = requestAnimationFrame(anim);
  }
  function sceneSheet(body) {
    const name = h('input', { type: 'text', value: scene.name });
    name.addEventListener('input', () => { scene.name = name.value; commitSoon(); clearTimeout(fpT); fpT = setTimeout(() => { saveNow(); fillProjects(); }, 500); });
    body.append(field('Project name', name));
    body.append(field('Shape of the video', h('div', { class: 'chips' }, ASPECTS.map(([k, l]) => h('button', { type: 'button', class: 'pick' + (scene.aspect === k ? ' on' : ''), onclick: () => { scene.aspect = k; commit(); sizeStage(); refreshSheet(); updAspect(); } }, l)))));
    body.append(field('Background', h('div', { class: 'chips' }, BGS.map(([k, l]) => h('button', { type: 'button', class: 'pick' + (scene.bg === k ? ' on' : ''), onclick: () => { scene.bg = k; commit(); dirty = true; refreshSheet(); } }, h('i', { class: 'bgdot', style: 'background:' + k }), l)),
      (() => { const c = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(scene.bg) ? scene.bg : '#000000', 'aria-label': 'Custom background' }); c.addEventListener('input', () => { scene.bg = c.value; dirty = true; commitSoon(); }); return c; })())));
    body.append(field('Length (seconds)', stepper(scene.duration, 1, v => { scene.duration = Math.max(1, v); commitSoon(); renderTimeline(); dirty = true; })));
    body.append(h('p', { class: 'muted small' }, 'The frame is 8 units tall with (0, 0) in the middle, as in Manim. Paper and White switch new objects to dark ink.'));
  }
  let fpT = null;
  function refreshSheetValues() {
    const o = selObj();
    if (sheetKind === 'position' && o) {
      document.querySelectorAll('#sheetBody .kfrow').forEach(row => {
        const inp = row.querySelector('input'), p = inp.dataset.prop;
        if (document.activeElement !== inp) inp.value = round(A.keyVal(o, p, time), 2);
        const k = o.keys[p] || [], here = k.some(q => Math.abs(q.t - time) < 0.026);
        const b = row.querySelector('.keybtn'); b.className = 'keybtn' + (here ? ' on' : k.length ? ' some' : ''); b.textContent = here ? '◆' : '◇';
      });
    }
    document.querySelectorAll('#sheetBody input[data-live]').forEach(i => { if (document.activeElement !== i && i._get) i.value = i._get(); });
    if (sheetKind && sheetKind.startsWith('add:')) { const p = document.querySelector('#sheetBody .small'); if (p) p.textContent = 'It’s added at the playhead (' + fmtT(time) + ') for 4 seconds. Drag it on the preview to place it.'; }
  }
  let prevT = null;
  function previewRange(a, b) {
    clearTimeout(prevT);
    setTime(Math.max(0, a)); setPlaying(true);
    prevT = setTimeout(() => { if (playing) { setPlaying(false); } }, Math.max(300, (b - a) * 1000));
  }
  function linkTransform(o, t) {
    o.anOut.target = t.id;
    const len = Math.max(1, t.end - t.start);
    t.start = round(o.end, 2); t.end = round(t.start + len, 2);
    t.anIn = Object.assign({}, t.anIn, { type: 'appear' });
    if (t.end > scene.duration) scene.duration = Math.ceil(t.end);
  }
  function move(d) {
    const i = scene.objects.findIndex(o => o.id === sel), j = i + d;
    if (j < 0 || j >= scene.objects.length) { toast(d > 0 ? 'Already at the front' : 'Already at the back'); return; }
    const a = scene.objects; [a[i], a[j]] = [a[j], a[i]];
    commit(); renderTimeline(); dirty = true; toast(d > 0 ? 'Moved forward' : 'Moved back');
  }
  function dup() {
    const o = selObj(); if (!o) return;
    const fam = [o, ...descendants(o)], ids = new Map(fam.map(x => [x.id, uid()]));
    const copies = clone(fam).map(c => { c.id = ids.get(c.id); if (c.parent && ids.has(c.parent)) c.parent = ids.get(c.parent); return c; });
    const c = copies[0]; c.name = o.name + ' copy'; shiftPos(c, 0.5, -0.5);
    scene.objects.push(...copies); commit(); select(c.id); toast('Copied');
  }
  async function del() {
    const o = selObj(); if (!o) return;
    const gone = [o, ...(o.type === 'group' ? descendants(o) : [])];
    scene.objects = scene.objects.filter(x => !gone.includes(x));
    gone.forEach(x => clearRefs(x.id));
    commit(); closeSheet(); select(null); toast((gone.length > 1 ? 'Deleted the group and its ' + (gone.length - 1) + ' members.' : 'Deleted.') + ' Undo with ↶');
  }

  // ---------- timeline: scrolls under a fixed centre playhead ----------
  const tl = $('#timeline');
  const scr = h('div', { class: 'tl-scroll' });
  tl.append(scr, h('div', { class: 'tl-ph', 'aria-hidden': 'true' }),
    h('div', { class: 'tl-zoom' }, h('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoom(1 / 1.4) }, '−'), h('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoom(1.4) }, '+')));
  let lastProg = -1, half = 0;
  function zoom(f) { pps = Math.max(12, Math.min(320, pps * f)); renderTimeline(); }
  function syncScroll() { if (!scene) return; const x = Math.round(time * pps); if (Math.abs(scr.scrollLeft - x) > 0.5) { lastProg = x; scr.scrollLeft = x; } }
  scr.addEventListener('scroll', () => {
    if (Math.abs(scr.scrollLeft - lastProg) <= 1) return;
    lastProg = -1;
    if (tdrag && tdrag.moved) return;
    if (playing) setPlaying(false);
    setTime(scr.scrollLeft / pps, true);
  }, { passive: true });
  function renderTimeline() {
    if (!scene) return;
    half = Math.round(scr.clientWidth / 2);
    const D = scene.duration;
    const inner = h('div', { class: 'tl-inner', style: 'width:' + (half * 2 + D * pps) + 'px' });
    const ruler = h('div', { class: 'tl-ruler' });
    const step = pps > 110 ? 0.5 : pps > 40 ? 1 : pps > 20 ? 2 : 5;
    for (let t = 0; t <= D + 1e-9; t += step) {
      const major = Math.abs(t / (step * 2) - Math.round(t / (step * 2))) < 1e-6;
      ruler.append(h('span', { class: 'tick' + (major ? '' : ' minor'), style: 'left:' + (half + t * pps) + 'px' }, major ? (Number.isInteger(t) ? fmtShort(t) : t.toFixed(1)) : ''));
    }
    ruler.append(h('div', { class: 'tl-endmark', style: 'left:' + (half + D * pps) + 'px' }));
    (scene.markers || []).forEach(m => ruler.append(h('div', { class: 'tl-marker', 'data-mt': m, title: 'Marker ' + fmtT(m), style: 'left:' + (half + m * pps) + 'px' })));
    inner.append(ruler);
    const rows = h('div', { class: 'tl-rows' });
    // pack clips into shared lanes (like a phone video editor); the front-most layer goes on top
    const lanes = [];
    const laneOf = new Map();
    scene.objects.forEach(o => {
      let li = lanes.findIndex(L => L.every(q => o.start >= q.end - 1e-6 || o.end <= q.start + 1e-6));
      if (li < 0) { lanes.push([]); li = lanes.length - 1; }
      lanes[li].push(o); laneOf.set(o.id, li);
    });
    const laneEls = lanes.map(() => h('div', { class: 'tl-row' }));
    scene.objects.forEach(o => {
      const { inD, outD } = A.phases(o);
      const isSel = o.id === sel;
      const clip = h('div', { class: 'tl-clip t-' + o.type + (isSel ? ' sel' : '') + (o.hidden ? ' hid' : '') + (o.parent ? ' kid' : ''), 'data-id': o.id, 'data-mode': 'move', style: 'left:' + (half + o.start * pps) + 'px;width:' + Math.max(8, (o.end - o.start) * pps) + 'px' },
        h('div', { class: 'ph in', style: 'width:' + inD * pps + 'px' }), h('div', { class: 'ph out', style: 'width:' + outD * pps + 'px' }),
        h('span', { class: 'clabel' }, h('b', {}, A.TYPES[o.type].icon), ' ', (MORPH(o.anOut.type) ? '⇢ ' : '') + (o.type === 'group' ? '' : '') + (o.parent ? '↳ ' : '') + o.name));
      if (isSel) clip.append(h('div', { class: 'hd l', 'data-id': o.id, 'data-mode': 'left', 'aria-label': 'Trim start' }), h('div', { class: 'hd r', 'data-id': o.id, 'data-mode': 'right', 'aria-label': 'Trim end' }));
      (o.emph || []).forEach((e, i) => clip.append(h('div', { class: 'em', 'data-id': o.id, 'data-mode': 'emph', 'data-i': i, title: e.type, style: 'left:' + (e.t - o.start) * pps + 'px;width:' + Math.max(8, e.dur * pps) + 'px' })));
      [...new Set(Object.values(o.keys || {}).flat().map(q => q.t))].forEach(t => clip.append(h('div', { class: 'kf', 'data-id': o.id, 'data-mode': 'key', 'data-t': t, style: 'left:' + (t - o.start) * pps + 'px' })));
      laneEls[laneOf.get(o.id)].append(clip);
    });
    laneEls.slice().reverse().forEach(el => rows.append(el));
    if (scene.audio) {
      const au = scene.audio, dur = sound.dur || 4, w = Math.max(8, dur * pps);
      const cw = Math.min(6000, Math.ceil(w)), wave = h('canvas', { class: 'wave', width: cw, height: 56, style: 'width:' + w + 'px' });
      if (sound.peaks) { const x = wave.getContext('2d'), P = sound.peaks; x.fillStyle = 'rgba(131,193,103,.85)'; for (let i = 0; i < cw; i++) { const v = P[Math.floor(i / cw * P.length)] || 0, hh = Math.max(1, v * 50); x.fillRect(i, 28 - hh / 2, 1, hh); } }
      rows.append(h('div', { class: 'tl-row audio' }, h('div', { class: 'tl-clip t-audio', 'data-id': 'audio', 'data-mode': 'audio', style: 'left:' + (half + (au.offset || 0) * pps) + 'px;width:' + w + 'px' }, wave, h('span', { class: 'clabel' }, '♪ ' + au.name))));
    }
    rows.append(h('div', { class: 'tl-row add' }, h('button', { type: 'button', class: 'tl-add', style: 'left:' + (half + time * pps + 8) + 'px', onclick: () => { select(null); openSheet('add:text'); } }, '＋ Add')));
    inner.append(rows);
    const keepY = scr.scrollTop;
    scr.textContent = '';
    scr.append(inner);
    scr.scrollTop = keepY;
    lastProg = Math.round(time * pps); scr.scrollLeft = lastProg;
  }
  const fmtShort = t => t >= 60 ? Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0') : t + 's';
  let rtT = null; const renderTimelineSoon = () => { clearTimeout(rtT); rtT = setTimeout(renderTimeline, 120); };

  let tdrag = null;
  scr.addEventListener('click', e => {
    if (tdrag && tdrag.moved) return;
    const mk = e.target.closest('.tl-marker');
    if (mk) { setTime(+mk.dataset.mt); return; }
    const c = e.target.closest('.tl-clip');
    if (c && c.dataset.id === 'audio') { select(null); openSheet('audio'); return; }
    if (c) { if (c.dataset.id !== sel) select(c.dataset.id); return; }
    if (e.target.closest('.tl-ruler')) { const r = scr.getBoundingClientRect(); setTime((e.clientX - r.left + scr.scrollLeft - half) / pps); return; }
    if (!e.target.closest('button') && sel) select(null);
  });
  scr.addEventListener('pointerdown', e => {
    const t = e.target.closest('[data-mode]') || e.target, m = t.dataset.mode;
    if (m === 'audio' && scene.audio) { tdrag = { mode: 'audio', x0: e.clientX, off0: scene.audio.offset || 0, moved: false, pid: e.pointerId, o: null }; scr.setPointerCapture(e.pointerId); return; }
    if (!m || !t.dataset.id || t.dataset.id !== sel) return;
    const o = selObj(); if (!o) return;
    tdrag = { mode: m, o, x0: e.clientX, snap0: clone(o), i: +t.dataset.i, kt: +t.dataset.t, moved: false, pid: e.pointerId, kids: m === 'move' ? descendants(o).map(c => [c, clone(c)]) : [] };
    scr.setPointerCapture(e.pointerId);
  });
  scr.addEventListener('pointermove', e => {
    if (!tdrag) return;
    const d = snap((e.clientX - tdrag.x0) / pps);
    if (!tdrag.moved && Math.abs(e.clientX - tdrag.x0) < 5) return;
    tdrag.moved = true;
    if (tdrag.mode === 'audio') { scene.audio.offset = round(tdrag.off0 + d); dirty = true; renderTimeline(); return; }
    const o = tdrag.o, s = tdrag.snap0;
    // snap to markers
    const snapM = (v0, dd) => { for (const m of scene.markers || []) if (Math.abs(v0 + dd - m) < 6 / pps * 2) return m - v0; return dd; };
    if (tdrag.mode === 'move') {
      let dd = Math.max(-s.start, d);
      const a = snapM(s.start, dd); if (a !== dd) dd = a; else dd = snapM(s.end, dd);
      o.start = round(s.start + dd); o.end = round(s.end + dd);
      o.emph = s.emph.map(x => Object.assign({}, x, { t: round(x.t + dd) }));
      o.keys = Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [k, v.map(q => ({ t: round(q.t + dd), v: q.v, ease: q.ease }))]));
      for (const [c, c0] of tdrag.kids) {
        c.start = round(c0.start + dd); c.end = round(c0.end + dd);
        c.emph = (c0.emph || []).map(x => Object.assign({}, x, { t: round(x.t + dd) }));
        c.keys = Object.fromEntries(Object.entries(c0.keys || {}).map(([k, v]) => [k, v.map(q => ({ t: round(q.t + dd), v: q.v, ease: q.ease }))]));
      }
    } else if (tdrag.mode === 'left') o.start = round(Math.max(0, Math.min(s.start + snapM(s.start, d), s.end - 0.2)));
    else if (tdrag.mode === 'right') o.end = round(Math.max(s.end + snapM(s.end, d), s.start + 0.2));
    else if (tdrag.mode === 'emph') o.emph[tdrag.i].t = round(Math.max(0, s.emph[tdrag.i].t + d));
    else if (tdrag.mode === 'key') {
      const nt = round(Math.max(0, tdrag.kt + d));
      o.keys = Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [k, v.map(q => Math.abs(q.t - tdrag.kt) < 1e-6 ? { t: nt, v: q.v, ease: q.ease } : q).sort((a, b) => a.t - b.t)]));
    }
    if (o.end > scene.duration) scene.duration = Math.ceil(o.end);
    dirty = true;
    renderTimeline();
  });
  const tup = () => {
    if (!tdrag) return;
    const td = tdrag;
    setTimeout(() => { tdrag = null; }, 0);
    if (!td.moved) { if (td.mode === 'key') setTime(td.kt); else if (td.mode === 'emph') setTime(td.o.emph[td.i].t); return; }
    if (td.mode === 'audio') { commit(); renderTimeline(); return; }
    scene.objects.forEach(x => { if (MORPH(x.anOut.type) && x.anOut.target) { const t = scene.objects.find(y => y.id === x.anOut.target); if (t && (x === td.o || t === td.o)) { if (t === td.o) x.end = t.start; else { const len = t.end - t.start; t.start = x.end; t.end = round(t.start + len); } } } });
    commit(); renderTimeline(); refreshSheet();
  };
  scr.addEventListener('pointerup', tup); scr.addEventListener('pointercancel', tup);
  // pinch to zoom the timeline
  let pinch = null;
  scr.addEventListener('touchstart', e => { if (e.touches.length === 2) { pinch = { d: Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1, p: pps }; } }, { passive: true });
  scr.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) { e.preventDefault(); const d = Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1; pps = Math.max(12, Math.min(320, pinch.p * d / pinch.d)); renderTimeline(); }
  }, { passive: false });
  scr.addEventListener('touchend', () => { pinch = null; });

  // ---------- export ----------
  function pickMime(withAudio) {
    if (typeof MediaRecorder === 'undefined') return null;
    const c = withAudio ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return c.find(m => MediaRecorder.isTypeSupported(m)) || '';
  }
  function exportSize(short) {
    const r = ratio(scene.aspect);
    return r >= 1 ? [Math.round(short * r / 2) * 2, short] : [short, Math.round(short / r / 2) * 2];
  }
  const slug = () => (scene.name || 'animation').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'animation';
  function download(name, blob) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); }
  function openExport() {
    setPlaying(false);
    const dlg = $('#exportDlg'); dlg.textContent = '';
    const withAudio = !!(scene.audio && sound.buf);
    const mime = pickMime(withAudio);
    const res = selectInput([['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K (slow on phones)']], '1080', () => info());
    const fps = selectInput([['30', '30 fps'], ['60', '60 fps']], '30', () => {});
    const sz = h('p', { class: 'muted small' });
    function info() { const [W, H] = exportSize(+res.value); sz.textContent = W + ' × ' + H + ' · ' + scene.aspect + ' · ' + fmtT(scene.duration) + ' · ' + (mime === null ? 'this browser can’t record video' : mime.includes('mp4') ? 'MP4' : 'WebM') + (withAudio ? ' · with sound' : scene.audio ? ' · sound not loaded, so silent' : ''); }
    info();
    const prog = h('progress', { max: 1, value: 0, hidden: true });
    const status = h('p', { class: 'small', 'aria-live': 'polite' });
    const out = h('div', { class: 'exportout' });
    let cancel = null;
    const go = h('button', { type: 'button', class: 'btn primary', disabled: mime === null, onclick: () => {
      go.disabled = true; prog.hidden = false; out.textContent = '';
      cancel = recordVideo(+res.value, +fps.value, mime, withAudio, (p, msg) => { prog.value = p; status.textContent = msg; }, (blob, ext) => {
        go.disabled = false; prog.hidden = true;
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        out.append(h('video', { src: url, controls: true, playsinline: true, loop: true }));
        out.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => download(slug() + ext, blob) }, '⤓ Save video')));
        if (inFrame) out.append(h('p', { class: 'muted small' }, 'This preview inside Claude can’t save files, so Save may do nothing here. It works in the version you install from GitHub.'));
      });
    } }, '● Record video');
    const png = h('button', { type: 'button', class: 'btn', onclick: () => {
      const [W, H] = exportSize(+res.value);
      const c = h('canvas'); c.width = W; c.height = H;
      A.render(c.getContext('2d'), scene, time, W, H);
      c.toBlob(b => { out.textContent = ''; out.append(h('img', { src: URL.createObjectURL(b), alt: 'Frame at ' + fmtT(time) })); out.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => download(slug() + '-' + time.toFixed(1) + 's.png', b) }, '⤓ Save image'))); }, 'image/png');
    } }, '◻ This frame as an image');
    dlg.append(h('div', { class: 'dlg' },
      h('h2', {}, 'Export'),
      h('div', { class: 'two' }, field('Resolution', res), field('Frame rate', fps)), sz,
      h('p', { class: 'muted small' }, 'Recording plays the scene in real time, so it takes as long as the scene. Keep the screen on until it finishes.'),
      prog, status, out,
      h('div', { class: 'row' }, go, png, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn quiet', onclick: () => { if (cancel) cancel(); dlg.close(); } }, 'Close'))));
    dlg.showModal();
  }
  function recordVideo(short, fps, mime, withAudio, onProg, onDone) {
    const [W, H] = exportSize(short);
    const c = h('canvas', { style: 'position:fixed;left:-99999px;top:0;width:10px;height:10px' }); c.width = W; c.height = H;
    document.body.append(c);
    const ctx = c.getContext('2d');
    A.render(ctx, scene, 0, W, H);
    let rec, ac = null, src = null;
    let stream = c.captureStream(fps);
    if (withAudio) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ac = new AC();
        const dest = ac.createMediaStreamDestination(), gain = ac.createGain();
        gain.gain.value = scene.audio.vol == null ? 1 : scene.audio.vol;
        src = ac.createBufferSource(); src.buffer = sound.buf; src.connect(gain); gain.connect(dest);
        stream = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      } catch (e) { ac = null; src = null; }
    }
    try { rec = new MediaRecorder(stream, Object.assign(mime ? { mimeType: mime } : {}, { videoBitsPerSecond: Math.round(Math.min(40e6, W * H * fps * 0.12)) })); }
    catch (e) { onProg(0, 'This browser can’t record video: ' + e.message); onDone(null); c.remove(); return null; }
    const chunks = [];
    let stopped = false, raf = 0;
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      cancelAnimationFrame(raf); c.remove();
      try { if (src) src.stop(); if (ac && ac.close) ac.close(); } catch (e) {}
      if (stopped === 'cancel') { onProg(0, 'Cancelled.'); onDone(null); return; }
      const type = rec.mimeType || mime || 'video/webm';
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? '.mp4' : '.webm';
      onProg(1, 'Done: ' + (blob.size / 1e6).toFixed(1) + ' MB ' + (ext === '.mp4' ? 'MP4' : 'WebM') + '.');
      if (!inFrame) download(slug() + ext, blob);
      onDone(blob, ext);
    };
    rec.start(500);
    if (src) { const off = scene.audio.offset || 0; if (ac.resume) ac.resume(); src.start(ac.currentTime + Math.max(0, off), Math.max(0, -off)); }
    const start = performance.now(), D = scene.duration;
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      A.render(ctx, scene, Math.min(t, D), W, H);
      onProg(Math.min(1, t / D), 'Recording… ' + fmtT(Math.min(t, D)) + ' of ' + fmtT(D));
      if (t >= D + 0.25) { stopped = true; rec.stop(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (!stopped) { stopped = 'cancel'; rec.stop(); } };
  }

  // ---------- project menu ----------
  function openMenu() {
    const dlg = $('#menuDlg'); dlg.textContent = '';
    const act = (label, fn, cls) => h('button', { type: 'button', class: 'btn ' + (cls || ''), onclick: () => { dlg.close(); fn(); } }, label);
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0]; if (!f) return;
      try {
        const s = JSON.parse(await f.text()); if (!s.objects) throw new Error('that file isn’t an Animath project');
        if (s.media) { for (const [id, u] of Object.entries(s.media)) { try { await putMedia(id, await dataURLToBlob(u)); } catch (e) {} } delete s.media; }
        sound.id = null; createProject(s); toast('Opened “' + s.name + '”');
      } catch (e) { toast('Couldn’t open it: ' + e.message); }
    });
    dlg.append(h('div', { class: 'dlg' }, h('h2', {}, 'Projects'), h('div', { class: 'menu' },
      act('＋ New blank project', () => createProject(newScene('Untitled ' + (index().length + 1)))),
      act('＋ New copy of the demo', () => createProject(demoScene())),
      act('⧉ Duplicate this project', () => { const s = clone(scene); s.name += ' copy'; createProject(s); }),
      act('⤓ Save project file (.json)', async () => {
        const s = clone(scene), media = {};
        for (const id of mediaIds(scene)) { const b = await getMedia(id); if (b) media[id] = await blobToDataURL(b); }
        if (Object.keys(media).length) s.media = media;
        download(slug() + '.animath.json', new Blob([JSON.stringify(s, null, 1)], { type: 'application/json' }));
      }),
      act('</> Manim Python code', () => openSheet('code')),
      act('＋ New copy of the features tour', () => createProject(tourScene())),
      act('⤒ Open a project file', () => fileIn.click()),
      act('⌫ Delete this project', async () => {
        if (!await ask('Delete “' + scene.name + '”? This can’t be undone.', 'Delete')) return;
        store.del('animath.p.' + projId);
        store.set('animath.index', index().filter(p => p.id !== projId));
        const next = index()[0];
        if (!(next && openProject(next.id))) createProject(demoScene());
      }, 'quiet')),
      h('p', { class: 'muted small' }, inFrame ? 'In this preview, projects are kept in this browser only. Saving and opening files works in the version you install from GitHub.' : 'Projects are saved in this app on this device. Save a project file now and then as a backup.'),
      fileIn,
      h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => dlg.close() }, 'Close'))));
    dlg.showModal();
  }

  // ---------- demo ----------
  function demoScene() {
    const s = newScene('Demo');
    s.duration = 26;
    const keep = scene, keepT = time; scene = s;
    const O = (type, over) => { time = over.start; const o = makeObj(type, over); s.objects.push(o); return o; };
    O('title', { name: 'Title', start: 0, end: 3.6, props: { title: 'Animath', subtitle: 'Manim-style animation, on your phone' }, anIn: { type: 'write', dur: 1.6, rate: 'linear' } });
    const e1 = O('math', { name: 'Euler', start: 3.6, end: 6.6, props: { tex: 'e^{i\\pi} + 1 = 0', size: 1.3 } });
    const e2 = O('math', { name: 'Basel', start: 6.6, end: 10, props: { tex: '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}', size: 1.1 }, emph: [{ type: 'circumscribe', t: 7.6, dur: 1.4 }] });
    e1.anOut = { type: 'transform', target: e2.id, dur: 1.2, rate: 'smooth' }; e2.anIn = { type: 'appear', dur: 0.5 };
    O('graph', { name: 'Graph', start: 10, end: 16, props: { f2: 'cos(x)', l2: '\\cos x', tracer: true }, anIn: { type: 'create', dur: 2.2, rate: 'smooth' } });
    O('venn', { name: 'Venn', start: 16, end: 21.5, x: -3.3, y: 0.2, scale: 0.85, props: { shade: 'A ∩ B' }, anIn: { type: 'create', dur: 1.5 } });
    O('truth', { name: 'Truth table', start: 16.6, end: 21.5, x: 3.4, y: 0, props: { formula: '(P -> Q) & P -> Q' }, emph: [{ type: 'indicate', t: 19.3, dur: 1 }] });
    O('sticker', { name: 'Sparkle', start: 18.6, end: 21.5, x: 6, y: 3, scale: 0.6, props: { kind: 'sparkle' }, anIn: { type: 'spin', dur: 0.8 }, loop: 'pulse' });
    const sq = O('shape', { name: 'Square', start: 21.5, end: 23.2, x: -2, props: { shape: 'square', fill: 'BLUE', fo: 0.5, color: 'BLUE' } });
    const ci = O('shape', { name: 'Circle', start: 23.2, end: 26, x: -2, props: { shape: 'circle', color: 'PINK', fill: 'PINK', fo: 0.5 }, keys: { x: [{ t: 23.6, v: -2 }, { t: 25, v: 2 }] } });
    sq.anOut = { type: 'transform', target: ci.id, dur: 1, rate: 'smooth' }; ci.anIn = { type: 'appear', dur: 0.5 };
    scene = keep; time = keepT;
    return s;
  }

  // a short scene that shows rigs, live values, graph riding, camera, paths, matching transforms and curved text
  function tourScene() {
    const s = newScene('Features tour');
    s.duration = 21;
    const keep = scene, keepT = time; scene = s;
    const O = (type, over) => { time = over.start; const o = makeObj(type, over); s.objects.push(o); return o; };
    O('title', { name: 'Title', start: 0, end: 3, props: { title: 'What’s new', subtitle: 'Rigs · live values · camera · paths' }, anIn: { type: 'write', dur: 1.4, rate: 'linear' } });
    s.vars = [{ name: 'a', v: -5, keys: [{ t: 4, v: -5 }, { t: 9, v: 5, ease: 'smooth' }] }];
    const g = O('graph', { name: 'Graph', start: 3, end: 11.5, props: { f1: 'sin(x) + x/4', l1: '' }, anIn: { type: 'create', dur: 1.5 } });
    O('shape', { name: 'Rider', start: 3.6, end: 11.5, scale: 2.2, props: { shape: 'dot', color: 'YELLOW' }, attach: { to: g.id, fn: 1, x: 'a', tilt: false }, anIn: { type: 'spring', dur: 0.8 } });
    O('math', { name: 'Readout', start: 3.6, end: 11.5, x: -4.5, y: 3.2, props: { tex: 'x = [[a:2]]', size: 0.8, color: 'YELLOW' }, anIn: { type: 'fadein', dur: 0.5 } });
    s.camera = { x: 0, y: 0, zoom: 1, rotation: 0, keys: { x: [{ t: 8, v: 0 }, { t: 9.3, v: 3.6 }, { t: 10.6, v: 0 }], y: [{ t: 8, v: 0 }, { t: 9.3, v: 0.6 }, { t: 10.6, v: 0 }], zoom: [{ t: 8, v: 1 }, { t: 9.3, v: 1.9, ease: 'spring' }, { t: 10.6, v: 1 }] } };
    const e1 = O('math', { name: 'Pythagoras', start: 11.5, end: 14, props: { tex: 'a^2 + b^2 = c^2', size: 1.2 } });
    const e2 = O('math', { name: 'Rearranged', start: 14, end: 16, props: { tex: 'a^2 = c^2 - b^2', size: 1.2 }, anIn: { type: 'appear', dur: 0.5 }, anOut: { type: 'fadeout', dur: 0.5 } });
    e1.anOut = { type: 'transformMatch', target: e2.id, dur: 1.4, rate: 'smooth' };
    const grp = O('group', { name: 'Pendulum', start: 16, end: 21, x: -3.5, y: 2.6, anIn: { type: 'fadein', dur: 0.5 }, anOut: { type: 'none', dur: 0 }, loop: 'pendulum' });
    O('shape', { name: 'Rod', start: 16, end: 21, parent: grp.id, x: 0, y: -1.3, rotation: 90, props: { shape: 'line', len: 2.6, color: 'GREY' }, anIn: { type: 'appear', dur: 0 }, anOut: { type: 'none', dur: 0 } });
    O('shape', { name: 'Bob', start: 16, end: 21, parent: grp.id, x: 0, y: -2.75, props: { shape: 'circle', r: 0.35, color: 'GOLD', fill: 'GOLD', fo: 0.9 }, anIn: { type: 'appear', dur: 0 }, anOut: { type: 'none', dur: 0 } });
    const path = O('vector', { name: 'Path', start: 16, end: 21, x: 2.6, y: -0.6, style: { dash: 'dashed', arrow: 'end' }, anIn: { type: 'create', dur: 1 },
      props: { paths: [{ nodes: [{ x: -2.4, y: 1.2, ox: 1.2, oy: -2.4 }, { x: 0, y: 0, ix: -0.8, iy: 0.8, ox: 0.8, oy: -0.8, smooth: true }, { x: 2.4, y: -1.2, ix: -1.2, iy: 2.4 }], closed: false, stroke: 'BLUE', sw: 3, fill: '', fo: 1 }] } });
    O('sticker', { name: 'Traveller', start: 16.8, end: 21, scale: 0.4, props: { kind: 'arrow' }, path: { to: path.id, ease: 'smooth', orient: true }, loop: 'none', anIn: { type: 'pop', dur: 0.4 } });
    O('textpath', { name: 'Arc title', start: 16.4, end: 21, y: 3.1, x: 2.6, props: { text: 'Rigs and paths', shape: 'arc', bend: 0.3, size: 0.55, color: 'TEAL' }, style: { grad: 'PINK', gangle: 0 }, anIn: { type: 'write', dur: 1, rate: 'linear' } });
    scene = keep; time = keepT;
    return s;
  }

  // ---------- wiring ----------
  function refreshAll() {
    sizeStage(); renderTools(); renderTimeline(); refreshSheet(); updAspect(); dirty = true;
    document.title = scene.name + ' · Animath';
  }
  document.querySelectorAll('.playbtn').forEach(b => b.addEventListener('click', () => setPlaying(!playing)));
  $('#toStart').addEventListener('click', () => { setPlaying(false); setTime(0); });
  $('#loopBtn').addEventListener('click', e => { const b = e.currentTarget; b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); });
  $('#guides').addEventListener('click', e => { guides = !guides; e.currentTarget.setAttribute('aria-pressed', guides); dirty = true; });
  $('#undo').addEventListener('click', () => undo(-1));
  $('#redo').addEventListener('click', () => undo(1));
  $('#exportBtn').addEventListener('click', openExport);
  $('#aspectBtn').addEventListener('click', () => {
    const d = h('dialog', { class: 'aspectdlg', 'aria-label': 'Video shape' });
    const grid = h('div', { class: 'aspgrid' });
    for (const [k, l] of ASPECTS) {
      const [w, hh] = k.split(':').map(Number), sc = 46 / Math.max(w, hh);
      grid.append(h('button', { type: 'button', class: 'asp' + (scene.aspect === k ? ' on' : ''), onclick: () => { scene.aspect = k; commit(); sizeStage(); refreshSheet(); updAspect(); d.close(); } },
        h('i', { style: 'width:' + Math.round(w * sc) + 'px;height:' + Math.round(hh * sc) + 'px' }), h('b', {}, k), h('span', {}, l.replace(/\s*\d+:\d+$/, ''))));
    }
    d.append(h('div', { class: 'dlg' }, h('h2', {}, 'Video shape'), grid, h('p', { class: 'muted small' }, 'Objects keep their positions in units, so a wider frame shows more around them.'), h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => d.close() }, 'Close'))));
    d.addEventListener('close', () => setTimeout(() => d.remove(), 50));
    document.body.append(d); d.showModal();
  });
  function updAspect() { $('#aspectBtn').textContent = scene.aspect + ' ▾'; }
  $('#menuBtn').addEventListener('click', openMenu);
  $('#proj').addEventListener('change', e => openProject(e.target.value));
  addEventListener('resize', () => { sizeStage(); renderTimeline(); });
  addEventListener('keydown', e => {
    const tag = (document.activeElement || {}).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey ? 1 : -1); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(1); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); dup(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); del(); }
    else if (e.key === 'ArrowLeft') setTime(time - (e.shiftKey ? 1 : 0.1));
    else if (e.key === 'ArrowRight') setTime(time + (e.shiftKey ? 1 : 0.1));
    else if (e.key === 'k' && sel) toggleAllKeys();
    else if (e.key === 'm' || e.key === 'M') addMarker();
    else if (e.key === 'Escape') { if (sheetKind) closeSheet(); else if (drw) endDraw(); else select(null); }
  });
  if (document.fonts) {
    Promise.all(['20px LM', 'italic 20px LM', 'bold 20px LM', 'italic bold 20px LM', '20px LMMath', '20px "IBM Plex Sans"', '20px "IBM Plex Mono"'].map(f => document.fonts.load(f).catch(() => null)))
      .then(() => { A.fontsChanged(); dirty = true; });
  }

  const cur = store.get('animath.current', null);
  if (!(cur && openProject(cur))) { const first = index()[0]; if (!(first && openProject(first.id))) createProject(demoScene()); }
  requestAnimationFrame(() => { renderTimeline(); syncScroll(); });
  requestAnimationFrame(loop);
  window.AnimathEditor = { get scene() { return scene; }, setTime, select, addObj, setPlaying, openSheet, get time() { return time; }, get soundPlaying() { return !!(sound.el && !sound.el.paused); } };
})();
