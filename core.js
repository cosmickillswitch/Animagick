/* Animath engine: builds scene objects into drawable primitives and renders any moment in time.
   Coordinates follow Manim: the frame is 8 units tall, the origin is the centre, y points up.
   Inside an object, primitives use local units with y pointing down (canvas style). */
(function () {
  'use strict';

  // ---------- colours and fonts ----------
  const PAL = {
    WHITE: '#FFFFFF', GREY: '#888888', BLUE: '#58C4DD', TEAL: '#5CD0B3', GREEN: '#83C167', YELLOW: '#FFFF00',
    GOLD: '#F0AC5F', ORANGE: '#FF862F', RED: '#FC6255', MAROON: '#C55F73', PURPLE: '#9A72AC', PINK: '#D147BD',
    BLUE_E: '#1C758A', GREEN_E: '#699C52', BLACK: '#000000', INK: '#1B1B1F'
  };
  const FALL = '"Latin Modern Roman","CMU Serif","Cambria Math","STIX Two Text","Times New Roman",serif';
  const FAM = {
    main: '"LM","LMMath",' + FALL, math: '"LM","LMMath",' + FALL, ams: '"LMMath",' + FALL, size1: '"LMMath","LM",' + FALL,
    cal: '"LMMath",' + FALL, sans: '"IBM Plex Sans",system-ui,sans-serif', mono: '"IBM Plex Mono",ui-monospace,monospace'
  };
  const fontCss = (st, px, fam) => (st || '') + ' ' + px + 'px ' + FAM[fam];
  function color(c) { if (!c) return c; return PAL[String(c).toUpperCase()] || c; }
  function hex2rgb(h) {
    h = color(h) || '#fff';
    if (h[0] !== '#') { const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(h); return m ? [+m[1], +m[2], +m[3]] : [255, 255, 255]; }
    if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    const n = parseInt(h.slice(1, 7), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  function mixColor(a, b, t) {
    if (t <= 0) return color(a); if (t >= 1) return color(b);
    const A = hex2rgb(a), B = hex2rgb(b);
    return 'rgb(' + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',') + ')';
  }

  // ---------- measuring ----------
  const mc = document.createElement('canvas').getContext('2d');
  let mcache = new Map();
  function meas(ch, fam, st) {
    const k = fam + '|' + (st || '') + '|' + ch;
    let m = mcache.get(k);
    if (m) return m;
    mc.font = fontCss(st, 100, fam);
    const r = mc.measureText(ch);
    m = { w: r.width / 100, a: (r.actualBoundingBoxAscent || 70) / 100, d: (r.actualBoundingBoxDescent || 0) / 100 };
    if (ch === ' ') { m.a = 0; m.d = 0; }
    mcache.set(k, m);
    return m;
  }

  // ---------- rate functions (Manim's smooth etc.) ----------
  const sig = x => 1 / (1 + Math.exp(-x));
  const RATE = {
    smooth: t => { const e = sig(-5); return Math.min(Math.max((sig(10 * (t - 0.5)) - e) / (1 - 2 * e), 0), 1); },
    linear: t => t,
    easeIn: t => t * t * t,
    easeOut: t => 1 - Math.pow(1 - t, 3),
    thereAndBack: t => { const u = t < 0.5 ? 2 * t : 2 * (1 - t); return RATE.smooth(u); },
    backOut: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    backIn: t => { const c1 = 1.70158, c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
    elastic: t => t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1,
    bounce: t => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375; return n * (t -= 2.625 / d) * t + 0.984375; }
  };
  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  // physics-flavoured curves
  RATE.spring = t => t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.exp(-6 * t) * Math.cos(t * Math.PI * 4.5);
  RATE.gravity = t => t * t;
  RATE.snap = t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
  // 'cb:x1,y1,x2,y2' is a CSS-style cubic-bezier easing
  const cbCache = new Map();
  function cubicBezier(x1, y1, x2, y2) {
    x1 = clamp(x1); x2 = clamp(x2);
    const B = (s, a, b) => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
    return t => {
      if (t <= 0) return 0; if (t >= 1) return 1;
      let lo = 0, hi = 1, s = t;
      for (let i = 0; i < 22; i++) { s = (lo + hi) / 2; if (B(s, x1, x2) < t) lo = s; else hi = s; }
      return B(s, y1, y2);
    };
  }
  function rateFn(name, def) {
    if (typeof name === 'string' && name.startsWith('cb:')) {
      let f = cbCache.get(name);
      if (!f) { const v = name.slice(3).split(',').map(Number); f = v.length === 4 && v.every(isFinite) ? cubicBezier(...v) : RATE.smooth; cbCache.set(name, f); }
      return f;
    }
    return RATE[name] || RATE[def || 'smooth'];
  }

  // ---------- 2D matrices [a, b, c, d, e, f]: (x, y) → (a x + c y + e, b x + d y + f) ----------
  const I = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const apv = (m, x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
  function inv(m) { const d = m[0] * m[3] - m[1] * m[2] || 1e-12; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; }
  const mT = (x, y) => [1, 0, 0, 1, x, y];
  const mR = r => { const c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
  const mS = (x, y) => [x, 0, 0, y, 0, 0];
  const mdet = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const FLIP = [1, 0, 0, -1, 0, 0];

  // ---------- TeX-like maths ----------
  const SYM = {};
  const def = (names, ch, cls, fam, st) => names.split(' ').forEach(n => { SYM[n] = { ch, cls, fam: fam || 'main', st: st || '' }; });
  'alpha α|beta β|gamma γ|delta δ|epsilon ϵ|varepsilon ε|zeta ζ|eta η|theta θ|vartheta ϑ|iota ι|kappa κ|lambda λ|mu μ|nu ν|xi ξ|pi π|varpi ϖ|rho ρ|varrho ϱ|sigma σ|tau τ|upsilon υ|phi ϕ|varphi φ|chi χ|psi ψ|omega ω'.split('|').forEach(p => { const [n, c] = p.split(' '); def(n, c, 'ord', 'math', 'italic'); });
  'Gamma Γ|Delta Δ|Theta Θ|Lambda Λ|Xi Ξ|Pi Π|Sigma Σ|Upsilon Υ|Phi Φ|Psi Ψ|Omega Ω'.split('|').forEach(p => { const [n, c] = p.split(' '); def(n, c, 'ord'); });
  [['leq le', '≤'], ['geq ge', '≥'], ['neq ne', '≠'], ['approx', '≈'], ['equiv', '≡'], ['sim', '∼'], ['simeq', '≃'], ['cong', '≅'], ['propto', '∝'],
    ['in', '∈'], ['notin', '∉'], ['ni', '∋'], ['subset', '⊂'], ['subseteq', '⊆'], ['supset', '⊃'], ['supseteq', '⊇'], ['to rightarrow', '→'], ['leftarrow gets', '←'],
    ['Rightarrow implies', '⇒'], ['Leftarrow impliedby', '⇐'], ['leftrightarrow', '↔'], ['Leftrightarrow iff', '⇔'], ['mapsto', '↦'], ['vdash', '⊢'], ['dashv', '⊣'],
    ['models vDash', '⊨'], ['parallel', '∥'], ['mid', '∣'], ['perp', '⊥'], ['ll', '≪'], ['gg', '≫'], ['coloneqq', '≔'], ['longrightarrow', '⟶'], ['uparrow', '↑'], ['downarrow', '↓']
  ].forEach(([n, c]) => def(n, c, 'rel'));
  [['times', '×'], ['cdot', '⋅'], ['div', '÷'], ['pm', '±'], ['mp', '∓'], ['cup', '∪'], ['cap', '∩'], ['setminus', '∖'], ['land wedge', '∧'], ['lor vee', '∨'],
    ['oplus', '⊕'], ['otimes', '⊗'], ['circ', '∘'], ['ast', '∗'], ['star', '⋆'], ['bullet', '∙'], ['triangle', '△']].forEach(([n, c]) => def(n, c, 'bin'));
  [['forall', '∀'], ['exists', '∃'], ['nexists', '∄'], ['neg lnot', '¬'], ['emptyset varnothing', '∅'], ['infty', '∞'], ['partial', '∂'], ['nabla', '∇'],
    ['top', '⊤'], ['bot', '⊥'], ['angle', '∠'], ['prime', '′'], ['ldots dots', '…'], ['cdots', '⋯'], ['hbar', 'ℏ'], ['ell', 'ℓ'], ['Box square', '□'], ['Diamond lozenge', '◇'],
    ['aleph', 'ℵ'], ['degree', '°'], ['checkmark', '✓'], ['therefore', '∴'], ['because', '∵'], ['%', '%'], ['#', '#'], ['&', '&'], ['_', '_'], ['$', '$'], ['|', '∥']
  ].forEach(([n, c]) => def(n, c, 'ord'));
  [['langle', '⟨', 'open'], ['rangle', '⟩', 'close'], ['lfloor', '⌊', 'open'], ['rfloor', '⌋', 'close'], ['lceil', '⌈', 'open'], ['rceil', '⌉', 'close'], ['{', '{', 'open'], ['}', '}', 'close']]
    .forEach(([n, c, k]) => def(n, c, k));
  const BIGOP = { sum: '∑', prod: '∏', coprod: '∐', bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀', int: '∫', iint: '∬', oint: '∮' };
  const FNS = 'sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh log ln exp lim max min sup inf det gcd deg dim ker arg Pr mod'.split(' ');
  const SPACE = { ',': 3 / 18, ':': 4 / 18, '>': 4 / 18, ';': 5 / 18, '!': -3 / 18, ' ': 0.3, quad: 1, qquad: 2, enspace: 0.5 };
  const BB = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ' };

  function parseTex(s) {
    let i = 0;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    function readName() {
      i++; // backslash
      if (!/[A-Za-z]/.test(s[i] || '')) return s[i++] || '';
      let n = '';
      while (i < s.length && /[A-Za-z]/.test(s[i])) n += s[i++];
      return n;
    }
    function raw() {
      ws();
      if (s[i] !== '{') return s[i++] || '';
      let depth = 0, out = '';
      i++;
      while (i < s.length) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') { if (!depth) break; depth--; }
        out += s[i++];
      }
      i++;
      return out;
    }
    function arg() {
      ws();
      if (s[i] === '{') { i++; const l = list('}'); i++; return { t: 'grp', l }; }
      if (s[i] === '\\') { const n = []; one(n); return n[0] || { t: 'grp', l: [] }; }
      return sym(s[i++] || '');
    }
    function delim() {
      ws();
      if (s[i] === '\\') { const n = readName(); return n === '.' ? '' : (SYM[n] ? SYM[n].ch : n === '|' ? '‖' : n === '{' ? '{' : n === '}' ? '}' : ''); }
      const c = s[i++]; return c === '.' ? '' : c;
    }
    function sym(c) {
      if (/[A-Za-z]/.test(c)) return { t: 's', ch: c, fam: 'math', st: 'italic', cls: 'ord' };
      if (c === '-') return { t: 's', ch: '−', fam: 'main', cls: 'bin' };
      if ('+*'.includes(c)) return { t: 's', ch: c === '*' ? '∗' : c, fam: 'main', cls: 'bin' };
      if ('=<>'.includes(c)) return { t: 's', ch: c, fam: 'main', cls: 'rel' };
      if (',;'.includes(c)) return { t: 's', ch: c, fam: 'main', cls: 'punct' };
      if ('([' .includes(c)) return { t: 's', ch: c, fam: 'main', cls: 'open' };
      if (')]!'.includes(c)) return { t: 's', ch: c, fam: 'main', cls: 'close' };
      if (c === "'") return { t: 's', ch: '′', fam: 'main', cls: 'ord' };
      if (c === ':') return { t: 's', ch: ':', fam: 'main', cls: 'rel' };
      const rel = '≤≥≠≈≡∈∉⊂⊆⊃⊇→←⇒⇔↔⊢⊨', bin = '×⋅÷±∪∩∧∨⊕⊗∘';
      return { t: 's', ch: c, fam: 'main', cls: rel.includes(c) ? 'rel' : bin.includes(c) ? 'bin' : 'ord' };
    }
    function one(out) {
      const c = s[i];
      if (c === '\\') {
        const n = readName();
        if (n === 'frac' || n === 'dfrac' || n === 'tfrac') { out.push({ t: 'frac', n: arg(), d: arg() }); return; }
        if (n === 'binom') { out.push({ t: 'lr', l: '(', r: ')', b: [{ t: 'frac', n: arg(), d: arg(), nobar: true }] }); return; }
        if (n === 'sqrt') { out.push({ t: 'sqrt', b: arg() }); return; }
        if (n === 'text' || n === 'textrm' || n === 'mathrm' || n === 'operatorname' || n === 'textit' || n === 'textbf') { out.push({ t: 'txt', s: raw(), st: n === 'textit' ? 'italic' : n === 'textbf' ? 'bold' : '', op: n === 'operatorname' }); return; }
        if (n === 'mathbf' || n === 'boldsymbol') { out.push({ t: 'style', st: 'bold', b: arg() }); return; }
        if (n === 'mathit') { out.push({ t: 'style', st: 'italic', b: arg() }); return; }
        if (n === 'mathbb') { raw2bb(raw()).forEach(x => out.push(x)); return; }
        if (n === 'mathcal') { raw().split('').forEach(ch => out.push({ t: 's', ch, fam: 'cal', cls: 'ord' })); return; }
        if (n === 'color' || n === 'textcolor') { out.push({ t: 'col', c: raw(), b: arg() }); return; }
        if (n === 'overline' || n === 'bar') { out.push({ t: 'over', b: arg() }); return; }
        if (n === 'vec' || n === 'hat' || n === 'tilde' || n === 'dot') { out.push({ t: 'acc', a: { vec: '→', hat: '^', tilde: '~', dot: '˙' }[n], b: arg() }); return; }
        if (n === 'left') {
          const l = delim();
          const b = list(null, true);
          let r = '';
          if (s.startsWith('\\right', i)) { i += 6; r = delim(); }
          out.push({ t: 'lr', l, r, b });
          return;
        }
        if (n === 'right') return;
        if (n in SPACE) { out.push({ t: 'sp', w: SPACE[n] }); return; }
        if (BIGOP[n]) { out.push({ t: 'op', ch: BIGOP[n], int: n.includes('int') }); return; }
        if (FNS.includes(n)) { out.push({ t: 'txt', s: n, op: true }); return; }
        if (SYM[n]) { const d = SYM[n]; out.push({ t: 's', ch: d.ch, fam: d.fam, st: d.st, cls: d.cls }); return; }
        out.push({ t: 'txt', s: '\\' + n, bad: true });
        return;
      }
      if (c === '{') { i++; out.push({ t: 'grp', l: list('}') }); i++; return; }
      if (c === '^' || c === '_') {
        i++;
        let base = out.pop() || { t: 'grp', l: [] };
        if (base.t !== 'sc') base = { t: 'sc', base };
        base[c === '^' ? 'sup' : 'sub'] = arg();
        out.push(base);
        return;
      }
      if (/\s/.test(c)) { i++; return; }
      if (c === '~') { i++; out.push({ t: 'sp', w: 0.33 }); return; }
      i++;
      out.push(sym(c));
    }
    function raw2bb(t) { return t.split('').map(ch => ({ t: 's', ch: BB[ch] || ch, fam: 'main', cls: 'ord', bb: ch })); }
    function list(end, stopRight) {
      const out = [];
      while (i < s.length) {
        if (end && s[i] === end) break;
        if (stopRight && s.startsWith('\\right', i)) break;
        one(out);
      }
      return out;
    }
    return list(null);
  }

  // Boxes: {w, a, d, items} with items in local coords (x right, y down, baseline at y=0).
  const box = (w, a, d, items) => ({ w, a, d, items: items || [] });
  function shift(items, dx, dy) {
    return items.map(p => {
      if (p.k === 'g') return Object.assign({}, p, { x: p.x + dx, y: p.y + dy });
      if (p.k === 'p') return Object.assign({}, p, { pts: p.pts.map(q => [q[0] + dx, q[1] + dy]) });
      return p;
    });
  }
  function glyphBox(ch, fam, st, z, c, sy) {
    const m = meas(ch, fam, st);
    return box(m.w * z, m.a * z * (sy || 1), m.d * z * (sy || 1), [{ k: 'g', ch, fam, st: st || '', z, x: 0, y: 0, c, sy: sy || 1 }]);
  }
  function hcat(boxes) {
    let x = 0, a = 0, d = 0;
    const items = [];
    for (const b of boxes) { items.push(...shift(b.items, x, 0)); x += b.w; a = Math.max(a, b.a); d = Math.max(d, b.d); }
    return box(x, a, d, items);
  }
  const line = (x1, y1, x2, y2, sw, c) => ({ k: 'p', pts: [[x1, y1], [x2, y2]], sw, stroke: c, closed: false });
  const SPC = { med: 4 / 18, thick: 5 / 18, thin: 3 / 18 };
  function spacing(a, b, script) {
    if (!a) return 0;
    if (a === 'punct') return SPC.thin;
    if (script) return 0;
    if (a === 'bin' || b === 'bin') return (a === 'bin' && b === 'bin') ? 0 : SPC.med;
    if (a === 'rel' || b === 'rel') return (a === 'rel' && b === 'rel') ? 0 : SPC.thick;
    if (a === 'op' && (b === 'ord' || b === 'open')) return SPC.thin;
    if (b === 'op' && a === 'ord') return SPC.thin;
    return 0;
  }

  function layoutList(list, z, c, depth, st) {
    const parts = [];
    let prev = null;
    for (const n of list) {
      let b = layoutNode(n, z, c, depth, st);
      if (!b) continue;
      let cls = b.cls || 'ord';
      if (cls === 'bin' && (!prev || ['bin', 'rel', 'open', 'punct', 'op'].includes(prev))) cls = 'ord';
      const sp = spacing(prev, cls, depth > 0);
      if (sp) parts.push(box(sp * z, 0, 0));
      parts.push(b);
      prev = cls;
    }
    if (prev === 'bin' && parts.length) { /* trailing bin becomes ord: TeX removes the space before it */ }
    return hcat(parts);
  }

  function layoutNode(n, z, c, depth, st) {
    const AX = 0.25 * z;
    switch (n.t) {
      case 's': {
        let fam = n.fam, sst = n.st || '';
        if (st === 'bold') { sst = fam === 'math' ? 'italic bold' : 'bold'; if (fam === 'math' && /[A-Za-z]/.test(n.ch)) { /* bold italic letter */ } }
        if (st === 'italic' && fam === 'main') sst = 'italic';
                const b = glyphBox(n.ch, fam, sst, z, c);
        if (fam === 'math') b.w += 0.03 * z;
        b.cls = n.cls;
        return b;
      }
      case 'grp': { const b = layoutList(n.l, z, c, depth, st); b.cls = 'ord'; return b; }
      case 'style': return layoutNode(n.b, z, c, depth, n.st);
      case 'col': return layoutNode(n.b, z, color(n.c.trim()) || c, depth, st);
      case 'sp': return box(n.w * z, 0, 0);
      case 'txt': {
        const fam = 'main';
        const sts = st === 'bold' ? 'bold' : n.st || '';
        const b = hcat(n.s.split('').map(ch => glyphBox(ch, fam, sts, z, n.bad ? '#FC6255' : c)));
        b.cls = n.op ? 'op' : 'ord';
        return b;
      }
      case 'frac': {
        const f = depth > 0 ? 0.75 : 0.9;
        const nb = layoutNode(n.n, z * f, c, depth + 1, st), db = layoutNode(n.d, z * f, c, depth + 1, st);
        const th = n.nobar ? 0 : 0.045 * z, gap = 0.14 * z;
        const w = Math.max(nb.w, db.w) + 0.24 * z;
        const ny = -AX - th / 2 - gap - nb.d, dy = -AX + th / 2 + gap + db.a;
        const items = [...shift(nb.items, (w - nb.w) / 2, ny), ...shift(db.items, (w - db.w) / 2, dy)];
        if (!n.nobar) items.push(line(0.06 * z, -AX, w - 0.06 * z, -AX, th, c));
        const b = box(w, -ny + nb.a, dy + db.d, items);
        b.cls = 'ord';
        return b;
      }
      case 'sqrt': {
        const b = layoutNode(n.b, z, c, depth, st);
        const top = -(b.a + 0.16 * z), bot = b.d + 0.1 * z, sw = 0.045 * z;
        const lead = 0.55 * z;
        const pts = [[0, (top + bot) / 2 + 0.08 * z], [0.12 * z, (top + bot) / 2 - 0.02 * z], [0.3 * z, bot], [lead - 0.04 * z, top], [lead + b.w + 0.1 * z, top]];
        const r = box(lead + b.w + 0.14 * z, -top + sw, bot, [...shift(b.items, lead + 0.04 * z, 0), { k: 'p', pts, sw, stroke: c, closed: false }]);
        r.cls = 'ord';
        return r;
      }
      case 'over': {
        const b = layoutNode(n.b, z, c, depth, st);
        const y = -(b.a + 0.1 * z);
        const r = box(b.w, -y + 0.04 * z, b.d, [...b.items, line(0.02 * z, y, b.w - 0.02 * z, y, 0.04 * z, c)]);
        r.cls = 'ord';
        return r;
      }
      case 'acc': {
        const b = layoutNode(n.b, z, c, depth, st);
        const a = glyphBox(n.a, 'main', '', z * (n.a === '→' ? 0.7 : 1), c);
        const y = -(b.a + 0.06 * z) + (n.a === '→' ? 0 : 0.35 * z);
        const r = box(Math.max(b.w, a.w), Math.max(b.a, -y + a.a), b.d, [...b.items, ...shift(a.items, (b.w - a.w) / 2 + 0.04 * z, y)]);
        r.cls = 'ord';
        return r;
      }
      case 'op': {
        const big = n.int ? 1.7 : 1.45;
        const g = glyphBox(n.ch, 'size1', '', z * big, c);
        const mid = (g.a - g.d) / 2;
        const items = shift(g.items, 0, -(AX - mid) + 0);
        const gb = box(g.w, g.a - mid + AX, g.d + mid - AX, items);
        gb.cls = 'op';
        gb.limits = !n.int;
        return gb;
      }
      case 'sc': {
        const base = layoutNode(n.base, z, c, depth, st);
        const sf = 0.7;
        const sup = n.sup ? layoutNode(n.sup, z * sf, c, depth + 1, st) : null;
        const sub = n.sub ? layoutNode(n.sub, z * sf, c, depth + 1, st) : null;
        if (base.limits && depth === 0) {
          const w = Math.max(base.w, sup ? sup.w : 0, sub ? sub.w : 0);
          const items = shift(base.items, (w - base.w) / 2, 0);
          let a = base.a, d = base.d;
          if (sup) { const y = -base.a - 0.12 * z - sup.d; items.push(...shift(sup.items, (w - sup.w) / 2, y)); a = -y + sup.a; }
          if (sub) { const y = base.d + 0.12 * z + sub.a; items.push(...shift(sub.items, (w - sub.w) / 2, y)); d = y + sub.d; }
          const r = box(w, a, d, items); r.cls = 'op'; return r;
        }
        let upY = -Math.max(0.36 * z, base.a - 0.28 * z), dnY = Math.max(0.15 * z, base.d + 0.08 * z);
        if (sup && sub) { const gap = (dnY - sub.a) - (upY + sup.d); if (gap < 0.12 * z) { dnY += 0.12 * z - gap; } }
        const x = base.w + (base.cls === 'op' && !base.limits ? -0.05 * z : 0.02 * z);
        const items = [...base.items];
        let w = base.w, a = base.a, d = base.d;
        if (sup) { items.push(...shift(sup.items, x, upY)); w = Math.max(w, x + sup.w); a = Math.max(a, -upY + sup.a); }
        if (sub) { items.push(...shift(sub.items, x, dnY)); w = Math.max(w, x + sub.w); d = Math.max(d, dnY + sub.d); }
        const r = box(w + 0.03 * z, a, d, items);
        r.cls = base.cls === 'op' ? 'op' : 'ord';
        return r;
      }
      case 'lr': {
        const b = layoutList(n.b, z, c, depth, st);
        const h = Math.max(b.a + b.d, 0.9 * z);
        const mid = (b.a - b.d) / 2;
        const mk = ch => {
          if (!ch) return box(0.05 * z, 0, 0);
          const m = meas(ch, 'main', '');
          const gh = (m.a + m.d) * z || z;
          const sy = Math.max(1, (h + 0.2 * z) / gh);
          const g = glyphBox(ch, 'main', '', z, c, sy);
          const gmid = (g.a - g.d) / 2;
          return box(g.w, b.a + 0.1 * z, b.d + 0.1 * z, shift(g.items, 0, -(mid - gmid)));
        };
        const r = hcat([mk(n.l), box(0.06 * z, 0, 0), b, box(0.06 * z, 0, 0), mk(n.r)]);
        r.cls = 'ord';
        return r;
      }
    }
    return null;
  }
  function texBox(src, z, c) { return layoutList(parseTex(src), z, c, 0, ''); }

  // Text with inline $maths$, several lines.
  function textLines(src, z, c, fam, st, align) {
    const lines = String(src).split('\n');
    const boxes = lines.map(L => {
      const parts = [];
      const segs = L.replace(/\\\$/g, '\u0001').split('$').map(x => x.replace(/\u0001/g, '\\$'));
      segs.forEach((seg, k) => {
        if (k % 2) parts.push(texBox(seg, z, c));
        else if (seg) parts.push(hcat(seg.replace(/\\\$/g, '$').split('').map(ch => glyphBox(ch, fam, st, z, c))));
      });
      const b = hcat(parts);
      if (!b.items.length) { b.a = 0.7 * z; b.d = 0.2 * z; }
      return b;
    });
    return stack(boxes, z * 1.3, align);
  }
  function stack(boxes, lh, align) {
    const W = Math.max(0, ...boxes.map(b => b.w));
    const items = [];
    let y = 0, top = 0, bottom = 0;
    boxes.forEach((b, i) => {
      if (i) y += Math.max(lh, boxes[i - 1].d + b.a + 0.15 * lh);
      const x = align === 'left' ? 0 : align === 'right' ? W - b.w : (W - b.w) / 2;
      items.push(...shift(b.items, x, y));
      if (i === 0) top = -b.a;
      bottom = y + b.d;
    });
    return box(W, -top, bottom, items);
  }
  function mathLines(src, z, c) {
    const lines = String(src).split(/\\\\/).map(s => s.trim()).filter((s, i, a) => s || a.length === 1);
    if (lines.some(l => l.includes('&'))) {
      const rows = lines.map(l => { const [L, R = ''] = l.split('&'); return [texBox(L, z, c), texBox(R, z, c)]; });
      const lw = Math.max(...rows.map(r => r[0].w));
      const boxes = rows.map(([L, R]) => { const b = hcat([box(lw - L.w, 0, 0), L, R]); return b; });
      return stack(boxes, z * 1.5, 'left');
    }
    return stack(lines.map(l => texBox(l, z, c)), z * 1.5, 'center');
  }

  // ---------- geometry helpers ----------
  function sampleArc(cx, cy, r, a0, a1, n) {
    const out = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push([cx + r * Math.cos(a), cy - r * Math.sin(a)]); }
    return out;
  }
  function svgPath(d, s = 1, ox = 0, oy = 0) {
    const toks = d.match(/[MLHVCQZmlhvcqz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
    const paths = [];
    let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0;
    const num = () => parseFloat(toks[i++]);
    const P = (px, py) => [(px - ox) * s, (py - oy) * s];
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
      const rel = cmd === cmd.toLowerCase();
      switch (cmd.toUpperCase()) {
        case 'M': x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); sx = x; sy = y; cur = { pts: [P(x, y)], closed: false }; paths.push(cur); cmd = rel ? 'l' : 'L'; break;
        case 'L': x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); cur.pts.push(P(x, y)); break;
        case 'H': x = num() + (rel ? x : 0); cur.pts.push(P(x, y)); break;
        case 'V': y = num() + (rel ? y : 0); cur.pts.push(P(x, y)); break;
        case 'C': {
          const x1 = num() + (rel ? x : 0), y1 = num() + (rel ? y : 0), x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0), x3 = num() + (rel ? x : 0), y3 = num() + (rel ? y : 0);
          for (let k = 1; k <= 16; k++) { const t = k / 16, u = 1 - t; cur.pts.push(P(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3)); }
          x = x3; y = y3; break;
        }
        case 'Q': {
          const x1 = num() + (rel ? x : 0), y1 = num() + (rel ? y : 0), x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0);
          for (let k = 1; k <= 12; k++) { const t = k / 12, u = 1 - t; cur.pts.push(P(u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2)); }
          x = x2; y = y2; break;
        }
        case 'Z': if (cur) { cur.closed = true; } x = sx; y = sy; i += 0; cmd = ''; break;
        default: i++;
      }
      if (cmd === '' && i < toks.length && !/[A-Za-z]/.test(toks[i])) i++;
    }
    return paths;
  }
  function arrowTip(x1, y1, x2, y2, size, c) {
    const a = Math.atan2(y2 - y1, x2 - x1), L = size, W = size * 0.55;
    const bx = x2 - Math.cos(a) * L, by = y2 - Math.sin(a) * L;
    return { k: 'p', pts: [[x2, y2], [bx - Math.sin(a) * W, by + Math.cos(a) * W], [bx + Math.sin(a) * W, by - Math.cos(a) * W]], closed: true, fill: c, fo: 1, stroke: c, sw: 0.01 };
  }
  const SW = v => (v == null ? 4 : v) * 0.0075;
  function niceStep(range) {
    const raw = range / 8, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  function fmtNum(v) { const r = Math.round(v * 1000) / 1000; return String(r).replace('-', '−'); }

  // ---------- expression parsers ----------
  const RESERVED = 'sin cos tan asin acos atan sinh cosh tanh exp log ln log10 log2 sqrt abs floor ceil round sign min max pow pi e x sec csc cot'.split(' ');
  // names: extra variable names, read from a second argument V (live values)
  function compileFn(src, names) {
    if (!src || !String(src).trim()) return null;
    const ALLOWED = { sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, sinh: 1, cosh: 1, tanh: 1, exp: 1, log: 1, ln: 1, log10: 1, log2: 1, sqrt: 1, abs: 1, floor: 1, ceil: 1, round: 1, sign: 1, min: 1, max: 1, pow: 1, pi: 1, e: 1, x: 1, sec: 1, csc: 1, cot: 1 };
    const VN = {};
    for (const n of names || []) if (!ALLOWED[n]) VN[n] = 1;
    const toks = String(src).replace(/π/g, 'pi').replace(/·|×/g, '*').replace(/−/g, '-').match(/\d*\.?\d+(?:e[+-]?\d+)?|[A-Za-z_]\w*|\*\*|[-+*/^(),]|\S/g) || [];
    let js = '', prev = '';
    for (const t of toks) {
      const isNum = /^\d|^\./.test(t), isId = /^[A-Za-z_]/.test(t);
      if (isId && !ALLOWED[t] && !VN[t]) throw new Error('Unknown name “' + t + '”');
      if (!isNum && !isId && !'+-*/^(),'.includes(t) && t !== '**') throw new Error('Unexpected “' + t + '”');
      const prevVal = /^\d|^\.|^[A-Za-z_]|\)$/.test(prev) && !(prev && ALLOWED[prev] && !['x', 'pi', 'e'].includes(prev));
      if (prevVal && (isNum || isId || t === '(')) js += '*';
      if (isId && VN[t] && !ALLOWED[t]) js += 'V.' + t;
      else if (isId) js += { pi: 'Math.PI', e: 'Math.E', x: 'x', ln: 'Math.log', log: 'Math.log10', sec: '1/Math.cos', csc: '1/Math.sin', cot: '1/Math.tan' }[t] || 'Math.' + t;
      else js += t === '^' ? '**' : t;
      prev = t;
    }
    // eslint-disable-next-line no-new-func
    const f = new Function('x', 'V', '"use strict";return (' + js + ');');
    const V0 = {}; for (const n in VN) V0[n] = 0.5;
    f(0.5, V0);
    return f;
  }
  // evaluate an expression with live values (and t, u) in V
  const ecache = new Map();
  function evalExpr(src, V) {
    if (typeof src === 'number') return src;
    const names = Object.keys(V || {});
    const key = names.join(',') + '|' + src;
    let f = ecache.get(key);
    if (f === undefined) { try { f = compileFn(src, names); } catch (e) { f = null; } if (ecache.size > 500) ecache.clear(); ecache.set(key, f); }
    if (!f) return NaN;
    try { return +f(V && V.x != null ? V.x : 0, V || {}); } catch (e) { return NaN; }
  }
  function fmtVal(v, d) {
    if (!isFinite(v)) return '?';
    if (d == null || d === '' || isNaN(+d)) d = Math.abs(v - Math.round(v)) < 1e-9 ? 0 : 2;
    return Number(v).toFixed(clamp(+d, 0, 8));
  }
  // [[expr]] or [[expr:digits]] in any text field is replaced by the live value
  const TPL = /\[\[([^\]]+)\]\]/g;
  const subst = (s, V) => String(s).replace(TPL, (m, e) => { const i = e.lastIndexOf(':'); const ex = i >= 0 ? e.slice(0, i) : e, dg = i >= 0 ? e.slice(i + 1) : null; return fmtVal(evalExpr(ex.trim(), V), dg); });
  const FORMULA_KEYS = { f1: 1, f2: 1, xt: 1, yt: 1 };
  function effProps(o, V, names) {
    const js = JSON.stringify(o.props || {});
    const hasT = js.indexOf('[[') >= 0;
    let hasN = false;
    if (names.length) for (const k in FORMULA_KEYS) if (typeof (o.props || {})[k] === 'string' && names.some(n => o.props[k].indexOf(n) >= 0)) { hasN = true; break; }
    if (!hasT && !hasN) return o;
    const p = {};
    for (const [k, v] of Object.entries(o.props)) {
      if (typeof v !== 'string') { p[k] = v; continue; }
      let s = hasT ? subst(v, V) : v;
      if (FORMULA_KEYS[k]) for (const n of names) if (s.indexOf(n) >= 0) s = s.replace(new RegExp('\\b' + n + '\\b', 'g'), '(' + fmtVal(V[n], 6) + ')');
      p[k] = s;
    }
    return Object.assign({}, o, { props: p });
  }

  function parseSet(src) {
    const s = String(src).replace(/\\cup|∪|\bunion\b|\|/g, ' ∪ ').replace(/\\cap|∩|\binter\b|&/g, ' ∩ ').replace(/\\setminus|∖|\\|−|-/g, ' ∖ ')
      .replace(/\^c|ᶜ|'/g, ' ᶜ ').replace(/Δ|\\triangle|⊕/g, ' Δ ').replace(/\\emptyset|∅/g, ' ∅ ');
    const toks = s.replace(/([()])/g, ' $1 ').split(/\s+/).filter(Boolean);
    let i = 0;
    function prim() {
      const t = toks[i++];
      let v;
      if (t === '(') { v = union(); i++; }
      else if (/^[A-Z]$/.test(t)) v = m => t === 'U' ? true : !!m[t];
      else if (t === '∅') v = () => false;
      else throw new Error('Unexpected ' + (t || 'end'));
      while (toks[i] === 'ᶜ') { const f = v; v = m => !f(m); i++; }
      return v;
    }
    function inter() { let v = prim(); while (toks[i] === '∩') { i++; const a = v, b = prim(); v = m => a(m) && b(m); } return v; }
    function union() {
      let v = inter();
      while (['∪', '∖', 'Δ'].includes(toks[i])) {
        const op = toks[i++], a = v, b = inter();
        v = op === '∪' ? m => a(m) || b(m) : op === '∖' ? m => a(m) && !b(m) : m => a(m) !== b(m);
      }
      return v;
    }
    if (!toks.length) return () => false;
    const f = union();
    if (i < toks.length) throw new Error('Unexpected ' + toks[i]);
    return f;
  }

  function parseLogic(src) {
    const s = String(src).replace(/<->|<=>|↔|\\leftrightarrow|\\iff|⇔|\biff\b/g, ' ↔ ').replace(/->|=>|→|\\to|\\rightarrow|⇒|\bimplies\b/g, ' → ')
      .replace(/&&|&|∧|\\land|\\wedge|\band\b/g, ' ∧ ').replace(/\|\||\||∨|\\lor|\\vee|\bor\b/g, ' ∨ ').replace(/~|!|¬|\\neg|\\lnot|\bnot\b/g, ' ¬ ')
      .replace(/⊕|\bxor\b/g, ' ⊕ ').replace(/⊤/g, ' T ').replace(/⊥/g, ' F ');
    const toks = s.replace(/([()])/g, ' $1 ').split(/\s+/).filter(Boolean);
    const letters = new Set();
    let i = 0;
    function atom() {
      const t = toks[i++];
      if (t === '¬') { const a = atom(); return { f: m => !a.f(m), s: '¬' + wrap(a, 9), p: 9 }; }
      if (t === '(') { const v = iff(); i++; return v; }
      if (t === 'T' || t === 'F') { const v = t === 'T'; return { f: () => v, s: v ? '⊤' : '⊥', p: 9 }; }
      if (/^[A-Z]$/.test(t)) { letters.add(t); return { f: m => m[t], s: t, p: 9 }; }
      throw new Error('Unexpected ' + (t || 'end'));
    }
    const wrap = (x, p) => x.p < p ? '(' + x.s + ')' : x.s;
    function bin(next, ops, p, right) {
      return function () {
        let a = next();
        while (ops.includes(toks[i])) {
          const op = toks[i++];
          const b = next();
          const A = a, B = b;
          const f = { '∧': m => A.f(m) && B.f(m), '∨': m => A.f(m) || B.f(m), '→': m => !A.f(m) || B.f(m), '↔': m => A.f(m) === B.f(m), '⊕': m => A.f(m) !== B.f(m) }[op];
          a = { f, s: wrap(A, p + 1) + ' ' + op + ' ' + wrap(B, right ? p : p + 1), p };
        }
        return a;
      };
    }
    const conj = bin(atom, ['∧'], 5), disj = bin(conj, ['∨', '⊕'], 4);
    function imp() { const a = disj(); if (toks[i] === '→') { i++; const b = imp(); return { f: m => !a.f(m) || b.f(m), s: wrap(a, 4) + ' → ' + b.s, p: 3 }; } return a; }
    function iff() { let a = imp(); while (toks[i] === '↔') { i++; const b = imp(); const A = a; a = { f: m => A.f(m) === b.f(m), s: wrap(A, 3) + ' ↔ ' + wrap(b, 3), p: 2 }; } return a; }
    const r = iff();
    if (i < toks.length) throw new Error('Unexpected ' + toks[i]);
    return { f: r.f, s: r.s, letters: [...letters].sort() };
  }

  // ---------- object types ----------
  const STICKERS = {
    star: null,
    heart: 'M50 86 C 22 66 6 48 14 30 C 22 13 43 14 50 31 C 57 14 78 13 86 30 C 94 48 78 66 50 86 Z',
    check: 'M13 53 L 29 37 L 43 51 L 73 21 L 89 37 L 43 83 Z',
    cross: 'M26 14 L50 38 L74 14 L86 26 L62 50 L86 74 L74 86 L50 62 L26 86 L14 74 L38 50 L14 26 Z',
    bulb: 'M50 8 C 27 8 16 27 21 44 C 24 56 36 62 37 73 L 63 73 C 64 62 76 56 79 44 C 84 27 73 8 50 8 Z M38 78 L62 78 L62 85 L38 85 Z M42 89 L58 89 L55 95 L45 95 Z',
    speech: 'M14 22 C14 15 19 10 26 10 L74 10 C81 10 86 15 86 22 L86 56 C86 63 81 68 74 68 L46 68 L27 88 L31 68 L26 68 C19 68 14 63 14 56 Z',
    thought: 'M30 62 C 14 62 10 46 22 40 C 16 26 32 16 42 24 C 48 10 70 12 72 26 C 88 24 94 44 80 50 C 88 64 68 72 60 64 C 54 72 36 72 30 62 Z M22 76 C 22 72 28 72 28 76 C 28 80 22 80 22 76 Z M12 88 C 12 86 16 86 16 88 C 16 90 12 90 12 88 Z',
    sparkle: 'M50 4 C 54 34 66 46 96 50 C 66 54 54 66 50 96 C 46 66 34 54 4 50 C 34 46 46 34 50 4 Z',
    arrow: 'M8 40 L58 40 L58 20 L94 50 L58 80 L58 60 L8 60 Z',
    question: null, exclaim: null, pin: 'M50 6 C 30 6 18 21 18 38 C 18 60 50 94 50 94 C 50 94 82 60 82 38 C 82 21 70 6 50 6 Z M50 26 C 43 26 38 31 38 38 C 38 45 43 50 50 50 C 57 50 62 45 62 38 C 62 31 57 26 50 26 Z',
    brain: 'M48 14 C 36 6 20 12 20 26 C 8 28 6 46 16 52 C 8 62 16 78 30 76 C 34 88 48 88 48 80 Z M52 14 C 64 6 80 12 80 26 C 92 28 94 46 84 52 C 92 62 84 78 70 76 C 66 88 52 88 52 80 Z'
  };
  const STICKER_COLORS = { star: '#F7C948', heart: '#FC6255', check: '#83C167', cross: '#FC6255', bulb: '#F7D96F', speech: '#FFFFFF', thought: '#FFFFFF', sparkle: '#F7D96F', arrow: '#58C4DD', question: '#9A72AC', exclaim: '#FF862F', pin: '#FC6255', brain: '#F4A6C6' };

  const TYPES = {
    text: {
      label: 'Text', icon: 'T',
      defaults: { text: 'Hello, $x^2$', size: 0.7, color: 'WHITE', font: 'main', style: '', align: 'center' },
      fields: [['text', 'Text ($…$ for maths)', 'textarea'], ['size', 'Size', 'num', 0.05], ['color', 'Colour', 'color'], ['font', 'Font', 'select', [['main', 'LaTeX serif'], ['sans', 'Sans'], ['mono', 'Mono']]],
        ['style', 'Style', 'select', [['', 'Regular'], ['bold', 'Bold'], ['italic', 'Italic']]], ['align', 'Align', 'select', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]]],
      build: p => textLines(p.text, p.size, color(p.color), p.font, p.style, p.align).items
    },
    math: {
      label: 'Maths', icon: '∑',
      defaults: { tex: 'e^{i\\pi} + 1 = 0', size: 0.9, color: 'WHITE' },
      fields: [['tex', 'LaTeX (\\\\ new line, & to align)', 'textarea'], ['size', 'Size', 'num', 0.05], ['color', 'Colour', 'color']],
      build: p => mathLines(p.tex, p.size, color(p.color)).items
    },
    title: {
      label: 'Title card', icon: 'H',
      defaults: { title: 'Blood–Brain Barrier', subtitle: 'An introduction', size: 1.1, color: 'WHITE', accent: 'BLUE', underline: true },
      fields: [['title', 'Title', 'textarea'], ['subtitle', 'Subtitle', 'textarea'], ['size', 'Size', 'num', 0.05], ['color', 'Colour', 'color'], ['accent', 'Accent', 'color'], ['underline', 'Underline', 'bool']],
      build: p => {
        const t = textLines(p.title, p.size, color(p.color), 'main', '', 'center');
        const items = [...t.items];
        let y = t.d + 0.3 * p.size;
        if (p.underline) { items.push({ k: 'p', pts: [[-0.05 * t.w, y], [t.w * 1.05, y]], sw: 0.035, stroke: color(p.accent), closed: false }); y += 0.25 * p.size; }
        if (p.subtitle) { const s = textLines(p.subtitle, p.size * 0.5, mixColor(color(p.color), '#888888', 0.25), 'main', 'italic', 'center'); items.push(...shift(s.items, (t.w - s.w) / 2, y + s.a)); }
        return items;
      }
    },
    shape: {
      label: 'Shape', icon: '◯',
      defaults: { shape: 'circle', r: 1, w: 2, h: 1.2, n: 6, len: 3, sweep: 270, color: 'BLUE', fill: 'BLUE', fo: 0, sw: 4 },
      fields: [['shape', 'Shape', 'select', [['circle', 'Circle'], ['square', 'Square'], ['rect', 'Rectangle'], ['polygon', 'Regular polygon'], ['star', 'Star'], ['line', 'Line'], ['arrow', 'Arrow'], ['darrow', 'Double arrow'], ['dot', 'Dot'], ['arc', 'Arc'], ['brace', 'Brace'], ['ellipse', 'Ellipse']]],
        ['r', 'Radius', 'num', 0.1, p => ['circle', 'polygon', 'star', 'arc', 'square'].includes(p.shape)], ['w', 'Width', 'num', 0.1, p => ['rect', 'brace', 'ellipse'].includes(p.shape)], ['h', 'Height', 'num', 0.1, p => ['rect', 'ellipse'].includes(p.shape)],
        ['n', 'Sides / points', 'num', 1, p => ['polygon', 'star'].includes(p.shape)], ['len', 'Length', 'num', 0.1, p => ['line', 'arrow', 'darrow'].includes(p.shape)], ['sweep', 'Sweep (°)', 'num', 5, p => p.shape === 'arc'],
        ['color', 'Stroke', 'color'], ['sw', 'Stroke width', 'num', 0.5], ['fill', 'Fill', 'color'], ['fo', 'Fill opacity', 'num', 0.05]],
      build: p => {
        const c = color(p.color), f = color(p.fill), sw = SW(p.sw);
        const P = (pts, closed) => ({ k: 'p', pts, closed, stroke: c, sw, fill: closed ? f : null, fo: closed ? p.fo : 0 });
        switch (p.shape) {
          case 'circle': return [P(sampleArc(0, 0, p.r, Math.PI / 2, Math.PI / 2 - Math.PI * 2, 96).slice(0, -1), true)];
          case 'ellipse': { const pts = []; for (let i = 0; i < 96; i++) { const a = Math.PI / 2 - i / 96 * Math.PI * 2; pts.push([p.w / 2 * Math.cos(a), -p.h / 2 * Math.sin(a)]); } return [P(pts, true)]; }
          case 'square': { const s = p.r; return [P([[-s, -s], [s, -s], [s, s], [-s, s]], true)]; }
          case 'rect': return [P([[-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [p.w / 2, p.h / 2], [-p.w / 2, p.h / 2]], true)];
          case 'polygon': { const n = Math.max(3, Math.round(p.n)), pts = []; for (let i = 0; i < n; i++) { const a = Math.PI / 2 + i * 2 * Math.PI / n; pts.push([p.r * Math.cos(a), -p.r * Math.sin(a)]); } return [P(pts, true)]; }
          case 'star': { const n = Math.max(3, Math.round(p.n)), pts = []; for (let i = 0; i < n * 2; i++) { const a = Math.PI / 2 + i * Math.PI / n, r = i % 2 ? p.r * 0.45 : p.r; pts.push([r * Math.cos(a), -r * Math.sin(a)]); } return [P(pts, true)]; }
          case 'line': return [P([[-p.len / 2, 0], [p.len / 2, 0]], false)];
          case 'arrow': return [P([[-p.len / 2, 0], [p.len / 2 - 0.2, 0]], false), arrowTip(-p.len / 2, 0, p.len / 2, 0, 0.3, c)];
          case 'darrow': return [P([[-p.len / 2 + 0.2, 0], [p.len / 2 - 0.2, 0]], false), arrowTip(-p.len / 2, 0, p.len / 2, 0, 0.3, c), arrowTip(p.len / 2, 0, -p.len / 2, 0, 0.3, c)];
          case 'dot': return [{ k: 'p', pts: sampleArc(0, 0, 0.08, 0, Math.PI * 2, 24).slice(0, -1), closed: true, stroke: c, sw: 0.01, fill: c, fo: 1 }];
          case 'arc': return [P(sampleArc(0, 0, p.r, 0, p.sweep * Math.PI / 180, 64), false)];
          case 'brace': {
            const w = p.w / 2, h = 0.22;
            const d = `M${-w} 0 C ${-w} ${h * 0.6} ${-w + 0.1} ${h * 0.5} ${-w * 0.5} ${h * 0.5} C ${-0.1} ${h * 0.5} 0 ${h * 0.6} 0 ${h} C 0 ${h * 0.6} 0.1 ${h * 0.5} ${w * 0.5} ${h * 0.5} C ${w - 0.1} ${h * 0.5} ${w} ${h * 0.6} ${w} 0`;
            return svgPath(d).map(q => ({ k: 'p', pts: q.pts, closed: false, stroke: c, sw: sw * 1.1 }));
          }
        }
        return [];
      }
    },
    geom: {
      label: 'Triangle', icon: '△',
      defaults: { pts: '-2,-1  2,-1  -1,1.6', labels: 'A B C', angles: true, degrees: false, sides: '', color: 'WHITE', fill: 'BLUE', fo: 0.25, accent: 'YELLOW', sw: 4 },
      fields: [['pts', 'Vertices (x,y …)', 'text'], ['labels', 'Vertex labels', 'text'], ['sides', 'Side labels (opposite each vertex)', 'text'], ['angles', 'Angle marks', 'bool'], ['degrees', 'Show degrees', 'bool'],
        ['color', 'Stroke', 'color'], ['fill', 'Fill', 'color'], ['fo', 'Fill opacity', 'num', 0.05], ['accent', 'Angle colour', 'color'], ['sw', 'Stroke width', 'num', 0.5]],
      build: p => {
        const V = String(p.pts).trim().split(/\s+/).map(s => s.split(',').map(Number)).filter(v => v.length === 2 && v.every(isFinite)).map(([x, y]) => [x, -y]);
        if (V.length < 2) return [];
        const items = [{ k: 'p', pts: V, closed: V.length > 2, stroke: color(p.color), sw: SW(p.sw), fill: color(p.fill), fo: p.fo }];
        const cx = V.reduce((s, v) => s + v[0], 0) / V.length, cy = V.reduce((s, v) => s + v[1], 0) / V.length;
        const labs = String(p.labels || '').trim().split(/\s+/).filter(Boolean);
        const sides = String(p.sides || '').trim().split(/\s+/).filter(Boolean);
        V.forEach((v, i) => {
          const a = V[(i + V.length - 1) % V.length], b = V[(i + 1) % V.length];
          const a1 = Math.atan2(-(a[1] - v[1]), a[0] - v[0]), a2 = Math.atan2(-(b[1] - v[1]), b[0] - v[0]);
          let d = a2 - a1; while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
          const deg = Math.abs(d) * 180 / Math.PI;
          if (p.angles && V.length > 2) {
            if (Math.abs(deg - 90) < 0.5) {
              const s = 0.28, u = [Math.cos(a1), -Math.sin(a1)], w = [Math.cos(a2), -Math.sin(a2)];
              items.push({ k: 'p', pts: [[v[0] + u[0] * s, v[1] + u[1] * s], [v[0] + (u[0] + w[0]) * s, v[1] + (u[1] + w[1]) * s], [v[0] + w[0] * s, v[1] + w[1] * s]], closed: false, stroke: color(p.accent), sw: SW(3) });
            } else items.push({ k: 'p', pts: sampleArc(v[0], v[1], 0.38, a1, a1 + d, 24), closed: false, stroke: color(p.accent), sw: SW(3) });
            if (p.degrees) {
              const m = a1 + d / 2, g = texBox(Math.round(deg) + '^\\circ', 0.32, color(p.accent));
              items.push(...shift(g.items, v[0] + Math.cos(m) * 0.75 - g.w / 2, v[1] - Math.sin(m) * 0.75 + (g.a - g.d) / 2));
            }
          }
          if (labs[i]) {
            let dx = v[0] - cx, dy = v[1] - cy; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
            const g = texBox(labs[i], 0.55, color(p.color));
            items.push(...shift(g.items, v[0] + dx * 0.38 - g.w / 2, v[1] + dy * 0.38 + (g.a - g.d) / 2));
          }
          if (sides[i] && V.length > 2) {
            const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            let dx = m[0] - cx, dy = m[1] - cy; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
            const g = texBox(sides[i], 0.5, color(p.color));
            items.push(...shift(g.items, m[0] + dx * 0.32 - g.w / 2, m[1] + dy * 0.32 + (g.a - g.d) / 2));
          }
        });
        return items;
      }
    },
    graph: {
      label: 'Graph', icon: '∿',
      defaults: { f1: 'sin(x)', c1: 'BLUE', l1: '\\sin x', f2: '', c2: 'YELLOW', l2: '', xmin: -6.5, xmax: 6.5, ymin: -2, ymax: 2, w: 10, h: 4.5, grid: false, nums: true, xl: 'x', yl: 'y', axis: 'WHITE', area: false, a: 0, b: 3.14159, areac: 'BLUE', tracer: false },
      fields: [['f1', 'y = (curve 1)', 'text'], ['c1', 'Colour 1', 'color'], ['l1', 'Label 1 (LaTeX)', 'text'], ['f2', 'y = (curve 2)', 'text'], ['c2', 'Colour 2', 'color'], ['l2', 'Label 2 (LaTeX)', 'text'],
        ['xmin', 'x from', 'num', 0.5], ['xmax', 'x to', 'num', 0.5], ['ymin', 'y from', 'num', 0.5], ['ymax', 'y to', 'num', 0.5], ['w', 'Width', 'num', 0.5], ['h', 'Height', 'num', 0.5],
        ['grid', 'Grid', 'bool'], ['nums', 'Numbers on axes', 'bool'], ['xl', 'x-axis label', 'text'], ['yl', 'y-axis label', 'text'], ['axis', 'Axis colour', 'color'],
        ['area', 'Shade area under curve 1', 'bool'], ['a', 'Area from x =', 'num', 0.1, p => p.area], ['b', 'Area to x =', 'num', 0.1, p => p.area], ['areac', 'Area colour', 'color', null, p => p.area],
        ['tracer', 'Dot travels along curve 1', 'bool']],
      build: p => {
        const xr = p.xmax - p.xmin || 1, yr = p.ymax - p.ymin || 1;
        const X = x => (x - p.xmin) / xr * p.w - p.w / 2, Y = y => -((y - p.ymin) / yr * p.h - p.h / 2);
        const ac = color(p.axis), items = [];
        const x0 = clamp(0, p.xmin, p.xmax), y0 = clamp(0, p.ymin, p.ymax);
        const sx = niceStep(xr), sy = niceStep(yr * 8 / 5);
        if (p.grid) {
          for (let v = Math.ceil(p.xmin / sx) * sx; v <= p.xmax + 1e-9; v += sx) items.push(Object.assign(line(X(v), Y(p.ymin), X(v), Y(p.ymax), 0.012, '#58C4DD'), { alpha: 0.35 }));
          for (let v = Math.ceil(p.ymin / sy) * sy; v <= p.ymax + 1e-9; v += sy) items.push(Object.assign(line(X(p.xmin), Y(v), X(p.xmax), Y(v), 0.012, '#58C4DD'), { alpha: 0.35 }));
        }
        items.push(line(X(p.xmin), Y(y0), X(p.xmax) + 0.15, Y(y0), 0.025, ac), arrowTip(X(p.xmin), Y(y0), X(p.xmax) + 0.3, Y(y0), 0.22, ac));
        items.push(line(X(x0), Y(p.ymin), X(x0), Y(p.ymax) - 0.15, 0.025, ac), arrowTip(X(x0), Y(p.ymin), X(x0), Y(p.ymax) - 0.3, 0.22, ac));
        const tick = 0.08;
        for (let v = Math.ceil(p.xmin / sx) * sx; v <= p.xmax + 1e-9; v += sx) {
          if (Math.abs(v) < 1e-9) continue;
          items.push(line(X(v), Y(y0) - tick, X(v), Y(y0) + tick, 0.02, ac));
          if (p.nums) { const g = texBox(fmtNum(v), 0.3, ac); items.push(...shift(g.items, X(v) - g.w / 2, Y(y0) + tick + 0.1 + g.a)); }
        }
        for (let v = Math.ceil(p.ymin / sy) * sy; v <= p.ymax + 1e-9; v += sy) {
          if (Math.abs(v) < 1e-9) continue;
          items.push(line(X(x0) - tick, Y(v), X(x0) + tick, Y(v), 0.02, ac));
          if (p.nums) { const g = texBox(fmtNum(v), 0.3, ac); items.push(...shift(g.items, X(x0) - tick - 0.1 - g.w, Y(v) + (g.a - g.d) / 2)); }
        }
        if (p.xl) { const g = texBox(p.xl, 0.45, ac); items.push(...shift(g.items, X(p.xmax) + 0.35, Y(y0) + (g.a - g.d) / 2)); }
        if (p.yl) { const g = texBox(p.yl, 0.45, ac); items.push(...shift(g.items, X(x0) - g.w / 2, Y(p.ymax) - 0.35 - g.d)); }
        const curve = (src, col, lab) => {
          let f; try { f = compileFn(src); } catch (e) { return; }
          if (!f) return;
          const N = 400; let seg = [];
          const segs = [];
          let prevY = null;
          for (let i = 0; i <= N; i++) {
            const x = p.xmin + xr * i / N; let y;
            try { y = f(x); } catch (e) { y = NaN; }
            const ok = isFinite(y) && y >= p.ymin - yr * 0.02 && y <= p.ymax + yr * 0.02 && !(prevY != null && Math.abs(y - prevY) > yr * 1.5);
            if (ok) seg.push([X(x), Y(y)]); else if (seg.length) { segs.push(seg); seg = []; }
            prevY = isFinite(y) ? y : null;
          }
          if (seg.length) segs.push(seg);
          segs.filter(s => s.length > 1).forEach(s => items.push({ k: 'p', pts: s, closed: false, stroke: color(col), sw: SW(4) }));
          if (lab && segs.length) {
            const last = segs[segs.length - 1], e = last[last.length - 1];
            const g = texBox(lab, 0.42, color(col));
            items.push(...shift(g.items, Math.min(e[0] + 0.1, p.w / 2 - g.w), e[1] - 0.2));
          }
          return f;
        };
        const f1 = curve(p.f1, p.c1, p.l1);
        const f2 = curve(p.f2, p.c2, p.l2);
        if (p.area && f1) {
          const a = Math.max(p.xmin, Math.min(p.a, p.b)), b = Math.min(p.xmax, Math.max(p.a, p.b));
          const pts = [[X(a), Y(y0)]];
          for (let i = 0; i <= 120; i++) { const x = a + (b - a) * i / 120; let y = f1(x); if (!isFinite(y)) y = 0; pts.push([X(x), Y(clamp(y, p.ymin, p.ymax))]); }
          pts.push([X(b), Y(y0)]);
          items.push({ k: 'p', pts, closed: true, stroke: null, sw: 0, fill: color(p.areac), fo: 0.45, ro: -1 });
        }
        if (p.tracer && f1) items.push({ k: 'tr', f: f1, X, Y, xmin: p.xmin, xmax: p.xmax, ymin: p.ymin, ymax: p.ymax, c: color(p.c1) });
        items.meta = { X, Y, f1, f2, xmin: p.xmin, xmax: p.xmax, ymin: p.ymin, ymax: p.ymax };
        return items;
      }
    },
    venn: {
      label: 'Venn', icon: '◎',
      defaults: { n: 2, labels: 'A B C', shade: 'A ∩ B', color: 'WHITE', shadec: 'BLUE', universe: true, ulabel: 'U', caption: true },
      fields: [['n', 'Sets', 'select', [[2, '2 sets'], [3, '3 sets']]], ['labels', 'Set labels', 'text'], ['shade', 'Shade (e.g. A ∩ B, A ∪ B, A \\ B, (A ∪ B)′)', 'text'], ['shadec', 'Shade colour', 'color'],
        ['color', 'Line colour', 'color'], ['universe', 'Show universe', 'bool'], ['ulabel', 'Universe label', 'text'], ['caption', 'Write the expression underneath', 'bool']],
      build: p => {
        const n = +p.n === 3 ? 3 : 2, r = 1.35;
        const C = n === 2 ? [[-0.8, 0], [0.8, 0]] : [[-0.72, -0.42], [0.72, -0.42], [0, 0.82]];
        const circles = C.map(([x, y]) => [x, -y, r]);
        const U = n === 2 ? [-2.9, -2, 2.9, 2] : [-2.8, -2.55, 2.8, 2.15];
        const names = ['A', 'B', 'C'];
        const labs = String(p.labels || '').trim().split(/\s+/);
        const items = [];
        let f = null; try { f = parseSet(p.shade); } catch (e) { f = null; }
        const terms = [];
        if (f) for (let m = 0; m < (1 << n); m++) { const env = {}; names.slice(0, n).forEach((k, i) => { env[k] = !!(m >> i & 1); }); if (f(env)) terms.push(m); }
        items.push({ k: 'v', circles, U: p.universe || terms.includes(0) ? U : null, terms, n, c: color(p.shadec), fo: 0.55, ro: 99 });
        if (p.universe) items.push({ k: 'p', pts: [[U[0], U[1]], [U[2], U[1]], [U[2], U[3]], [U[0], U[3]]], closed: true, stroke: color(p.color), sw: SW(3) });
        circles.forEach(([x, y]) => items.push({ k: 'p', pts: sampleArc(x, y, r, Math.PI / 2, Math.PI / 2 - 2 * Math.PI, 96).slice(0, -1), closed: true, stroke: color(p.color), sw: SW(4) }));
        circles.forEach(([x, y], i) => {
          const g = texBox(labs[i] || names[i], 0.6, color(p.color));
          const dx = n === 2 ? (i ? 1 : -1) : x, dy = n === 2 ? -0.7 : y;
          const L = Math.hypot(dx, dy) || 1;
          items.push(...shift(g.items, x + dx / L * (r + 0.25) - g.w / 2, y + dy / L * (r + 0.25) + (g.a - g.d) / 2));
        });
        if (p.universe && p.ulabel) { const g = texBox(p.ulabel, 0.5, color(p.color)); items.push(...shift(g.items, U[0] + 0.15, U[1] + 0.15 + g.a)); }
        if (p.caption && p.shade) { const g = texBox(String(p.shade).replace(/\\(?!cup|cap|setminus|emptyset)/g, '\\setminus ').replace(/'/g, '^{c}'), 0.55, color(p.shadec)); items.push(...shift(g.items, -g.w / 2, U[3] + 0.3 + g.a)); }
        return items;
      }
    },
    truth: {
      label: 'Truth table', icon: '⊤',
      defaults: { formula: 'P -> Q', size: 0.5, color: 'WHITE', tcol: 'GREEN', fcol: 'RED', style: 'TF', colour: true },
      fields: [['formula', 'Formula (P, Q, R… with ¬ ∧ ∨ → ↔ or ~ & | -> <->)', 'text'], ['size', 'Size', 'num', 0.05], ['color', 'Colour', 'color'], ['style', 'Values', 'select', [['TF', 'T / F'], ['10', '1 / 0']]],
        ['colour', 'Colour the result column', 'bool'], ['tcol', 'True colour', 'color'], ['fcol', 'False colour', 'color']],
      build: p => {
        let L; try { L = parseLogic(p.formula); } catch (e) { return textLines('Can’t read: ' + e.message, 0.4, '#FC6255', 'main', '', 'center').items; }
        const z = p.size, c = color(p.color);
        const cols = [...L.letters, L.s];
        const heads = cols.map(s => texBox(s.replace(/¬/g, '\\neg ').replace(/∧/g, '\\land ').replace(/∨/g, '\\lor ').replace(/→/g, '\\to ').replace(/↔/g, '\\leftrightarrow ').replace(/⊕/g, '\\oplus ').replace(/⊤/g, '\\top ').replace(/⊥/g, '\\bot '), z, c));
        const pad = 0.5 * z;
        const widths = heads.map(h => Math.max(h.w, 0.8 * z) + 2 * pad);
        const rowH = 1.25 * z, n = L.letters.length, rows = 1 << n;
        const W = widths.reduce((a, b) => a + b, 0);
        const items = [];
        let x = 0;
        heads.forEach((h, i) => { items.push(...shift(h.items, x + (widths[i] - h.w) / 2, rowH * 0.7)); x += widths[i]; });
        items.push(line(0, rowH, W, rowH, 0.025, c));
        const vx = widths.slice(0, n).reduce((a, b) => a + b, 0);
        items.push(line(vx, 0, vx, rowH * (rows + 1), 0.025, c));
        for (let r = 0; r < rows; r++) {
          const m = {};
          L.letters.forEach((k, i) => { m[k] = !((r >> (n - 1 - i)) & 1); });
          const vals = [...L.letters.map(k => m[k]), L.f(m)];
          let xx = 0;
          vals.forEach((v, i) => {
            const s = p.style === '10' ? (v ? '1' : '0') : (v ? 'T' : 'F');
            const col = i === n && p.colour ? color(v ? p.tcol : p.fcol) : c;
            const g = textLines(s, z, col, 'main', '', 'center');
            items.push(...shift(g.items, xx + (widths[i] - g.w) / 2, rowH * (r + 1.7)));
            xx += widths[i];
          });
        }
        return items;
      }
    },
    sticker: {
      label: 'Sticker', icon: '★',
      defaults: { kind: 'star', size: 1.4, fill: '', color: 'WHITE', outline: true },
      fields: [['kind', 'Sticker', 'select', Object.keys(STICKERS).map(k => [k, k[0].toUpperCase() + k.slice(1)])], ['size', 'Size', 'num', 0.1], ['fill', 'Fill (blank = default)', 'color'], ['color', 'Outline', 'color'], ['outline', 'Sticker border', 'bool']],
      build: p => {
        const s = p.size / 100, fill = color(p.fill) || STICKER_COLORS[p.kind] || '#fff';
        const P = pts => ({ k: 'p', pts, closed: true, stroke: color(p.color), sw: p.outline ? 0.09 * p.size / 1.4 : SW(3), under: !!p.outline, fill, fo: 1 });
        if (p.kind === 'star') { const pts = []; for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 19 : 46; pts.push([r * Math.cos(a) * s, -r * Math.sin(a) * s]); } return [P(pts)]; }
        if (p.kind === 'question' || p.kind === 'exclaim') {
          const g = glyphBox(p.kind === 'question' ? '?' : '!', 'main', 'bold', 62 * s, '#FFFFFF');
          return [P(sampleArc(0, 0, 44 * s, 0, Math.PI * 2, 64).slice(0, -1)), ...shift(g.items, -g.w / 2, (g.a - g.d) / 2)];
        }
        return svgPath(STICKERS[p.kind] || STICKERS.heart, s, 50, 50).map(q => P(q.pts));
      }
    },
    vector: {
      label: 'Drawing', icon: '✎', noCenter: true,
      defaults: { paths: [] },
      fields: [],
      build: p => {
        const out = [];
        for (const path of p.paths || []) {
          const n = path.nodes || [];
          if (!n.length) continue;
          if (n.length === 1) { out.push({ k: 'p', pts: sampleArc(n[0].x, n[0].y, Math.max(0.03, SW(path.sw) / 2), 0, Math.PI * 2, 16).slice(0, -1), closed: true, stroke: null, sw: 0, fill: color(path.stroke), fo: 1 }); continue; }
          const pts = [[n[0].x, n[0].y]];
          const seg = (a, b) => {
            const x0 = a.x, y0 = a.y, x1 = a.x + (a.ox || 0), y1 = a.y + (a.oy || 0), x2 = b.x + (b.ix || 0), y2 = b.y + (b.iy || 0), x3 = b.x, y3 = b.y;
            const straight = !a.ox && !a.oy && !b.ix && !b.iy;
            const N = straight ? 1 : 28;
            for (let k = 1; k <= N; k++) { const t = k / N, u = 1 - t; pts.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]); }
          };
          for (let i = 0; i < n.length - 1; i++) seg(n[i], n[i + 1]);
          if (path.closed) { seg(n[n.length - 1], n[0]); pts.pop(); }
          out.push({ k: 'p', pts, closed: !!path.closed, stroke: path.sw > 0 ? color(path.stroke) : null, sw: SW(path.sw), fill: path.closed && path.fill ? color(path.fill) : null, fo: path.closed && path.fill ? (path.fo == null ? 1 : path.fo) : 0 });
        }
        return out;
      }
    },
    net: {
      label: 'Nodes', icon: '⋰',
      defaults: { layout: 'ring', n: 7, r: 2.2, node: 0.17, nodec: 'BLUE', edgec: 'WHITE', directed: false, curved: false, labels: 'none', motion: 'drift', speed: 1, seed: 3 },
      fields: [['layout', 'Layout', 'select', [['ring', 'Ring'], ['complete', 'Complete (every pair)'], ['star', 'Star'], ['wheel', 'Wheel'], ['path', 'Path'], ['grid', 'Grid'], ['tree', 'Tree'], ['random', 'Random'], ['petersen', 'Petersen graph']]],
        ['n', 'Nodes', 'num', 1, p => p.layout !== 'petersen'], ['r', 'Size', 'num', 0.1], ['node', 'Node size', 'num', 0.02], ['nodec', 'Node colour', 'color'], ['edgec', 'Line colour', 'color'],
        ['directed', 'Arrows', 'bool'], ['curved', 'Curved lines', 'bool'], ['labels', 'Labels', 'select', [['none', 'None'], ['num', '1, 2, 3…'], ['abc', 'A, B, C…'], ['v', 'v₁, v₂…']]],
        ['motion', 'Motion', 'select', [['none', 'Still'], ['drift', 'Drift'], ['breathe', 'Breathe'], ['rotate', 'Rotate'], ['wave', 'Wave'], ['jitter', 'Jitter']]], ['speed', 'Motion speed', 'num', 0.1, p => p.motion !== 'none'],
        ['seed', 'Random seed', 'num', 1, p => p.layout === 'random']],
      build: p => {
        const { pts, edges } = netLayout(p);
        const R = Math.max(0.5, ...pts.map(([x, y]) => Math.hypot(x, y))) + p.node + 0.3;
        return [{ k: 'dyn', bb: [-R, -R, R, R], draw: (ctx, lt, pi, col, scale) => drawNet(ctx, p, pts, edges, lt, pi, col, scale) }];
      }
    },
    curve: {
      label: 'Curve', icon: '∞',
      defaults: { shape: 'lissajous', a: 3, b: 2, k: 5, turns: 3, size: 2.4, color: 'TEAL', sw: 4, xt: 'cos(3t) + cos(5t)/3', yt: 'sin(2t)', t0: 0, t1: 6.2832 },
      fields: [['shape', 'Curve', 'select', [['lissajous', 'Lissajous'], ['rose', 'Rose'], ['spiral', 'Spiral'], ['cardioid', 'Cardioid'], ['heart', 'Heart'], ['butterfly', 'Butterfly'], ['astroid', 'Astroid'], ['epicycloid', 'Epicycloid'], ['spiro', 'Spirograph'], ['lemniscate', 'Lemniscate ∞'], ['custom', 'Your own x(t), y(t)']]],
        ['a', 'a (x frequency)', 'num', 1, p => p.shape === 'lissajous'], ['b', 'b (y frequency)', 'num', 1, p => p.shape === 'lissajous'], ['k', 'Petals / cusps', 'num', 1, p => p.shape === 'rose' || p.shape === 'epicycloid'],
        ['turns', 'Turns', 'num', 0.5, p => p.shape === 'spiral'], ['xt', 'x(t) =', 'text', null, p => p.shape === 'custom'], ['yt', 'y(t) =', 'text', null, p => p.shape === 'custom'],
        ['t0', 't from', 'num', 0.1, p => p.shape === 'custom'], ['t1', 't to', 'num', 0.1, p => p.shape === 'custom'], ['size', 'Size', 'num', 0.1], ['color', 'Colour', 'color'], ['sw', 'Stroke width', 'num', 0.5]],
      build: p => {
        const P2 = Math.PI * 2, S = p.size;
        let fx, fy, t0 = 0, t1 = P2, norm = 1;
        const a = p.a, b = p.b, k = Math.max(1, Math.round(p.k));
        switch (p.shape) {
          case 'lissajous': fx = t => Math.sin(a * t + Math.PI / 2); fy = t => Math.sin(b * t); break;
          case 'rose': fx = t => Math.cos(k * t) * Math.cos(t); fy = t => Math.cos(k * t) * Math.sin(t); t1 = k % 2 ? Math.PI : P2; break;
          case 'spiral': t1 = P2 * Math.max(0.5, p.turns); fx = t => t / t1 * Math.cos(t); fy = t => t / t1 * Math.sin(t); break;
          case 'cardioid': fx = t => (2 * Math.cos(t) - Math.cos(2 * t)) / 3; fy = t => (2 * Math.sin(t) - Math.sin(2 * t)) / 3; break;
          case 'heart': fx = t => 16 * Math.pow(Math.sin(t), 3) / 17; fy = t => (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17; break;
          case 'butterfly': t1 = 12 * Math.PI; { const r = t => Math.exp(Math.cos(t)) - 2 * Math.cos(4 * t) - Math.pow(Math.sin(t / 12), 5); fx = t => Math.sin(t) * r(t) / 4.2; fy = t => Math.cos(t) * r(t) / 4.2; } break;
          case 'astroid': fx = t => Math.pow(Math.cos(t), 3); fy = t => Math.pow(Math.sin(t), 3); break;
          case 'epicycloid': fx = t => ((k + 1) * Math.cos(t) - Math.cos((k + 1) * t)) / (k + 2); fy = t => ((k + 1) * Math.sin(t) - Math.sin((k + 1) * t)) / (k + 2); break;
          case 'spiro': t1 = 10 * Math.PI; fx = t => (3 * Math.cos(t) + 4 * Math.cos(3 * t / 5)) / 7; fy = t => (3 * Math.sin(t) - 4 * Math.sin(3 * t / 5)) / 7; break;
          case 'lemniscate': fx = t => Math.cos(t) / (1 + Math.sin(t) ** 2); fy = t => Math.sin(t) * Math.cos(t) / (1 + Math.sin(t) ** 2); break;
          default: {
            const cx = compileFn(String(p.xt).replace(/(^|[^A-Za-z])t(?![A-Za-z])/g, '$1x')), cy = compileFn(String(p.yt).replace(/(^|[^A-Za-z])t(?![A-Za-z])/g, '$1x'));
            if (!cx || !cy) return [];
            fx = cx; fy = cy; t0 = p.t0; t1 = p.t1;
            let m = 0; for (let i = 0; i <= 200; i++) { const t = t0 + (t1 - t0) * i / 200; m = Math.max(m, Math.abs(fx(t)) || 0, Math.abs(fy(t)) || 0); }
            norm = m > 0 ? 1 / m : 1;
          }
        }
        const N = 900, pts = [];
        for (let i = 0; i <= N; i++) { const t = t0 + (t1 - t0) * i / N; const x = fx(t), y = fy(t); if (isFinite(x) && isFinite(y)) pts.push([x * S * norm, -y * S * norm]); }
        return pts.length > 1 ? [{ k: 'p', pts, closed: false, stroke: color(p.color), sw: SW(p.sw) }] : [];
      }
    },
    fractal: {
      label: 'Fractal', icon: '❄',
      defaults: { kind: 'koch', depth: 4, size: 2.6, color: 'BLUE', fill: true, angle: 25, sw: 2.5 },
      fields: [['kind', 'Fractal', 'select', [['koch', 'Koch snowflake'], ['sierpinski', 'Sierpiński triangle'], ['tree', 'Fractal tree'], ['dragon', 'Dragon curve'], ['hilbert', 'Hilbert curve'], ['carpet', 'Sierpiński carpet']]],
        ['depth', 'Depth', 'num', 1], ['angle', 'Branch angle (°)', 'num', 1, p => p.kind === 'tree'], ['size', 'Size', 'num', 0.1], ['color', 'Colour', 'color'], ['fill', 'Filled', 'bool', null, p => p.kind === 'sierpinski' || p.kind === 'koch' || p.kind === 'carpet'], ['sw', 'Stroke width', 'num', 0.5]],
      build: p => {
        const c = color(p.color), S = p.size, sw = SW(p.sw);
        const D = Math.max(0, Math.round(p.depth));
        switch (p.kind) {
          case 'koch': {
            let pts = [0, 1, 2].map(i => { const a = Math.PI / 2 + i * 2 * Math.PI / 3; return [Math.cos(a) * S, -Math.sin(a) * S]; });
            for (let d = 0; d < Math.min(D, 6); d++) {
              const out = [];
              for (let i = 0; i < pts.length; i++) {
                const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
                const dx = (x2 - x1) / 3, dy = (y2 - y1) / 3;
                const ax = x1 + dx, ay = y1 + dy, bx = x1 + 2 * dx, by = y1 + 2 * dy;
                const px = ax + dx * 0.5 - dy * Math.sqrt(3) / 2, py = ay + dy * 0.5 + dx * Math.sqrt(3) / 2;
                out.push([x1, y1], [ax, ay], [px, py], [bx, by]);
              }
              pts = out;
            }
            return [{ k: 'p', pts, closed: true, stroke: c, sw, fill: c, fo: p.fill ? 0.35 : 0 }];
          }
          case 'sierpinski': {
            const tris = [];
            const rec = (a, b, cc, d) => { if (d === 0) { tris.push([a, b, cc]); return; } const m = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2]; const ab = m(a, b), bc = m(b, cc), ca = m(cc, a); rec(a, ab, ca, d - 1); rec(ab, b, bc, d - 1); rec(ca, bc, cc, d - 1); };
            const h = S * Math.sqrt(3) / 2;
            rec([-S, h * 0.66], [S, h * 0.66], [0, -h * 1.33], Math.min(D, 6));
            return tris.map(t => ({ k: 'p', pts: t, closed: true, stroke: c, sw: sw * 0.6, fill: c, fo: p.fill ? 0.8 : 0 }));
          }
          case 'carpet': {
            const out = [];
            const rec = (x, y, s, d) => {
              if (d === 0) { out.push({ k: 'p', pts: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]], closed: true, stroke: c, sw: sw * 0.4, fill: c, fo: p.fill ? 0.85 : 0 }); return; }
              const t = s / 3;
              for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!(i === 1 && j === 1)) rec(x + i * t, y + j * t, t, d - 1);
            };
            rec(-S, -S, 2 * S, Math.min(D, 4));
            return out;
          }
          case 'tree': {
            const out = [], ang = p.angle * Math.PI / 180, max = Math.min(D + 1, 11);
            const rec = (x, y, a, len, d) => {
              const x2 = x + Math.cos(a) * len, y2 = y - Math.sin(a) * len;
              out.push({ k: 'p', pts: [[x, y], [x2, y2]], closed: false, stroke: c, sw: sw * Math.max(0.35, (max - d) / max * 1.6), ro: d });
              if (d + 1 < max) { rec(x2, y2, a + ang, len * 0.72, d + 1); rec(x2, y2, a - ang, len * 0.72, d + 1); }
            };
            rec(0, S, Math.PI / 2, S * 0.62, 0);
            return out;
          }
          case 'dragon': {
            let seq = [];
            for (let i = 0; i < Math.min(D + 4, 15); i++) seq = [...seq, 1, ...seq.slice().reverse().map(v => -v)];
            let x = 0, y = 0, dir = 0; const pts = [[0, 0]];
            for (const s2 of seq) { dir += s2; x += Math.cos(dir * Math.PI / 2); y += Math.sin(dir * Math.PI / 2); pts.push([x, y]); }
            x += Math.cos((dir) * Math.PI / 2); pts.push([x, y]);
            return [{ k: 'p', pts: fitPts(pts, S), closed: false, stroke: c, sw }];
          }
          case 'hilbert': {
            const n = Math.pow(2, Math.min(Math.max(D, 1), 7)), pts = [];
            for (let i = 0; i < n * n; i++) {
              let t = i, x = 0, y = 0;
              for (let s2 = 1; s2 < n; s2 *= 2) {
                const rx = 1 & (t / 2), ry = 1 & (t ^ rx);
                if (ry === 0) { if (rx === 1) { x = s2 - 1 - x; y = s2 - 1 - y; } [x, y] = [y, x]; }
                x += s2 * rx; y += s2 * ry; t = Math.floor(t / 4);
              }
              pts.push([x, y]);
            }
            return [{ k: 'p', pts: fitPts(pts, S), closed: false, stroke: c, sw }];
          }
        }
        return [];
      }
    },
    solid: {
      label: '3D shape', icon: '⬢',
      defaults: { shape: 'icosahedron', size: 1.8, yaw: 25, pitch: 20, spin: 30, tilt: 0, style: 'both', color: 'BLUE', edgec: 'WHITE', fo: 0.85, persp: true },
      fields: [['shape', 'Shape', 'select', [['cube', 'Cube'], ['tetrahedron', 'Tetrahedron'], ['octahedron', 'Octahedron'], ['icosahedron', 'Icosahedron'], ['dodecahedron', 'Dodecahedron'], ['pyramid', 'Square pyramid'], ['prism', 'Triangular prism'], ['cylinder', 'Cylinder'], ['cone', 'Cone'], ['sphere', 'Sphere'], ['torus', 'Torus']]],
        ['style', 'Look', 'select', [['both', 'Faces and edges'], ['faces', 'Faces only'], ['wire', 'Wireframe']]], ['size', 'Size', 'num', 0.1],
        ['yaw', 'Turn (°)', 'num', 5], ['pitch', 'Tilt (°)', 'num', 5], ['spin', 'Spin (°/s)', 'num', 5], ['tilt', 'Tumble (°/s)', 'num', 5],
        ['color', 'Face colour', 'color'], ['edgec', 'Edge colour', 'color'], ['fo', 'Face opacity', 'num', 0.05], ['persp', 'Perspective', 'bool']],
      build: p => {
        const m = mesh(p.shape);
        const R = p.size * (p.persp ? 1.1 : 1);
        return [{ k: 'dyn', bb: [-R, -R, R, R], draw: (ctx, lt, pi, col, scale) => drawSolid(ctx, p, m, lt, pi, col, scale) }];
      }
    }
  };

  // ---------- nodes, 3D and fractal helpers ----------
  function fitPts(pts, S) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const k = 2 * S / Math.max(x1 - x0, y1 - y0, 1e-9), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return pts.map(([x, y]) => [(x - cx) * k, -(y - cy) * k]);
  }
  function rng(seed) { let s = (Math.abs(Math.round(seed)) * 9301 + 49297) % 233280 || 1; return () => (s = (s * 9301 + 49297) % 233280) / 233280; }
  function netLayout(p) {
    const n = Math.max(2, Math.min(40, Math.round(p.n))), r = p.r, pts = [], edges = [];
    const ring = (m, rad, off = 0) => { for (let i = 0; i < m; i++) { const a = Math.PI / 2 + off + i * 2 * Math.PI / m; pts.push([rad * Math.cos(a), -rad * Math.sin(a)]); } };
    switch (p.layout) {
      case 'complete': ring(n, r); for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push([i, j]); break;
      case 'star': pts.push([0, 0]); ring(n - 1, r); for (let i = 1; i < n; i++) edges.push([0, i]); break;
      case 'wheel': pts.push([0, 0]); ring(n - 1, r); for (let i = 1; i < n; i++) { edges.push([0, i]); edges.push([i, i % (n - 1) + 1]); } break;
      case 'path': for (let i = 0; i < n; i++) { pts.push([-r + 2 * r * i / (n - 1), (i % 2 ? 0.35 : -0.35) * r / 2]); if (i) edges.push([i - 1, i]); } break;
      case 'grid': { const c = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / c), sp = 2 * r / Math.max(c - 1, 1); for (let i = 0; i < n; i++) { const x = i % c, y = Math.floor(i / c); pts.push([-r + x * sp, -(rows - 1) * sp / 2 + y * sp]); if (x > 0) edges.push([i - 1, i]); if (y > 0) edges.push([i - c, i]); } break; }
      case 'tree': { const depth = Math.ceil(Math.log2(n + 1)); for (let i = 0; i < n; i++) { const d = Math.floor(Math.log2(i + 1)), k = i + 1 - Math.pow(2, d), w = Math.pow(2, d); pts.push([-r + 2 * r * (k + 0.5) / w, -r + 2 * r * d / Math.max(depth - 1, 1)]); if (i) edges.push([(i - 1) >> 1, i]); } break; }
      case 'random': {
        const R = rng(p.seed);
        for (let i = 0; i < n; i++) { let best = null, bd = -1; for (let tries = 0; tries < 30; tries++) { const a = R() * Math.PI * 2, rr = r * Math.sqrt(R()), c = [rr * Math.cos(a), rr * Math.sin(a)]; const d = Math.min(9, ...pts.map(q => Math.hypot(q[0] - c[0], q[1] - c[1]))); if (d > bd) { bd = d; best = c; } } pts.push(best); }
        for (let i = 1; i < n; i++) { let j = 0, bd = Infinity; for (let k = 0; k < i; k++) { const d = Math.hypot(pts[i][0] - pts[k][0], pts[i][1] - pts[k][1]); if (d < bd) { bd = d; j = k; } } edges.push([j, i]); }
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (R() < 0.12 && !edges.some(e => (e[0] === i && e[1] === j) || (e[0] === j && e[1] === i))) edges.push([i, j]);
        break;
      }
      case 'petersen': ring(5, r); ring(5, r * 0.48); for (let i = 0; i < 5; i++) { edges.push([i, (i + 1) % 5]); edges.push([i, i + 5]); edges.push([5 + i, 5 + (i + 2) % 5]); } break;
      default: ring(n, r); for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n]);
    }
    return { pts, edges };
  }
  function drawNet(ctx, p, base, edges, lt, pi, col, scale) {
    const sp = p.speed, rad = p.node;
    let pts = base;
    if (p.motion !== 'none') {
      const ang = p.motion === 'rotate' ? lt * sp * 0.5 : 0, br = p.motion === 'breathe' ? 1 + 0.12 * Math.sin(lt * sp * 2) : 1;
      pts = base.map(([x, y], i) => {
        let X = x * br, Y = y * br;
        if (ang) { const c = Math.cos(ang), s = Math.sin(ang); [X, Y] = [X * c - Y * s, X * s + Y * c]; }
        if (p.motion === 'drift') { X += 0.14 * Math.sin(lt * sp * 1.3 + i * 1.7); Y += 0.14 * Math.cos(lt * sp * 1.1 + i * 2.3); }
        if (p.motion === 'wave') Y += 0.25 * Math.sin(lt * sp * 3 - x * 1.5);
        if (p.motion === 'jitter') { X += 0.04 * Math.sin(lt * 23 * sp + i * 7); Y += 0.04 * Math.cos(lt * 19 * sp + i * 5); }
        return [X, Y];
      });
    }
    const ef = clamp(pi * 1.7), nf = clamp((pi - 0.35) / 0.65);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const ec = col(color(p.edgec)), nc = col(color(p.nodec));
    ctx.strokeStyle = ec; ctx.fillStyle = ec; ctx.lineWidth = SW(3) / Math.max(scale, 0.05);
    for (const [i, j] of edges) {
      const [x1, y1] = pts[i], [x2, y2] = pts[j];
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      const sx = x1 + ux * rad, sy = y1 + uy * rad, ex = x2 - ux * (rad + (p.directed ? 0.02 : 0)), ey = y2 - uy * (rad + (p.directed ? 0.02 : 0));
      const mx = (sx + ex) / 2 - uy * L * 0.18, my = (sy + ey) / 2 + ux * L * 0.18;
      ctx.beginPath(); ctx.moveTo(sx, sy);
      if (ef >= 1) { if (p.curved) ctx.quadraticCurveTo(mx, my, ex, ey); else ctx.lineTo(ex, ey); }
      else if (p.curved) { const t = ef, ax = sx + (mx - sx) * t, ay = sy + (my - sy) * t, bx = mx + (ex - mx) * t, by = my + (ey - my) * t; ctx.quadraticCurveTo(ax, ay, ax + (bx - ax) * t, ay + (by - ay) * t); }
      else ctx.lineTo(sx + (ex - sx) * ef, sy + (ey - sy) * ef);
      ctx.stroke();
      if (p.directed && ef >= 1) {
        const tx = p.curved ? ex - mx : ex - sx, ty = p.curved ? ey - my : ey - sy, tl = Math.hypot(tx, ty) || 1;
        const a = arrowTip(ex - tx / tl * 0.3, ey - ty / tl * 0.3, ex, ey, 0.2, ec);
        ctx.beginPath(); a.pts.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fill();
      }
    }
    if (nf <= 0) return;
    pts.forEach(([x, y], i) => {
      const s = RATE.backOut(clamp(nf * 1.4 - i / pts.length * 0.4));
      if (s <= 0) return;
      ctx.beginPath(); ctx.arc(x, y, rad * s, 0, Math.PI * 2);
      ctx.fillStyle = nc; ctx.fill();
      ctx.lineWidth = SW(2) / Math.max(scale, 0.05); ctx.strokeStyle = '#ffffff'; ctx.globalAlpha *= 0.9; ctx.stroke(); ctx.globalAlpha /= 0.9;
      if (p.labels !== 'none' && s > 0.6) {
        const lab = p.labels === 'num' ? String(i + 1) : p.labels === 'abc' ? String.fromCharCode(65 + i % 26) : 'v' + '₀₁₂₃₄₅₆₇₈₉'[(i + 1) % 10];
        ctx.save(); ctx.translate(x, y); ctx.scale(0.01, 0.01);
        ctx.font = fontCss(p.labels === 'abc' ? 'italic' : '', Math.round(rad * 135 * s), p.labels === 'num' ? 'main' : 'math');
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#0B0B10'; ctx.shadowBlur = 0;
        ctx.fillText(p.labels === 'v' ? 'v' + (i + 1) : lab, 0, rad * 6);
        ctx.restore();
      }
    });
  }
  const MESH = {};
  function mesh(name) {
    if (MESH[name]) return MESH[name];
    let V = [], F = [], ref = null;
    const PHI = (1 + Math.sqrt(5)) / 2;
    const tri3 = (Vs, edge) => { const out = []; const n = Vs.length; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) { const d = (a, b) => Math.hypot(Vs[a][0] - Vs[b][0], Vs[a][1] - Vs[b][1], Vs[a][2] - Vs[b][2]); if (Math.abs(d(i, j) - edge) < 1e-6 && Math.abs(d(j, k) - edge) < 1e-6 && Math.abs(d(i, k) - edge) < 1e-6) out.push([i, j, k]); } return out; };
    switch (name) {
      case 'cube': for (let i = 0; i < 8; i++) V.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]); F = [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]]; break;
      case 'tetrahedron': V = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]; F = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]; break;
      case 'octahedron': V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]; for (const a of [0, 1]) for (const b of [2, 3]) for (const c of [4, 5]) F.push([a, b, c]); break;
      case 'icosahedron': case 'dodecahedron': {
        const I = []; for (const a of [-1, 1]) for (const b of [-PHI, PHI]) { I.push([0, a, b]); I.push([a, b, 0]); I.push([b, 0, a]); }
        const IF = tri3(I, 2);
        if (name === 'icosahedron') { V = I; F = IF; break; }
        V = IF.map(f => [0, 1, 2].map(k => (I[f[0]][k] + I[f[1]][k] + I[f[2]][k]) / 3));
        F = I.map((v, vi) => {
          const fs = IF.map((f, fi) => [f, fi]).filter(([f]) => f.includes(vi)).map(([, fi]) => fi);
          const n = v.map(x => x / Math.hypot(...v));
          const u = (() => { const c = V[fs[0]]; const d = [c[0] - v[0], c[1] - v[1], c[2] - v[2]]; const dot = d[0] * n[0] + d[1] * n[1] + d[2] * n[2]; const w = [d[0] - n[0] * dot, d[1] - n[1] * dot, d[2] - n[2] * dot]; const L = Math.hypot(...w); return w.map(x => x / L); })();
          const w2 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
          return fs.map(fi => { const c = V[fi]; const d = [c[0] - v[0], c[1] - v[1], c[2] - v[2]]; return [fi, Math.atan2(d[0] * w2[0] + d[1] * w2[1] + d[2] * w2[2], d[0] * u[0] + d[1] * u[1] + d[2] * u[2])]; }).sort((a, b) => a[1] - b[1]).map(x => x[0]);
        });
        break;
      }
      case 'pyramid': V = [[-1, -0.7, -1], [1, -0.7, -1], [1, -0.7, 1], [-1, -0.7, 1], [0, 1.1, 0]]; F = [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]; break;
      case 'prism': { for (const y of [-1, 1]) for (let i = 0; i < 3; i++) { const a = i * 2 * Math.PI / 3; V.push([Math.cos(a), y, Math.sin(a)]); } F = [[0, 1, 2], [3, 4, 5], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]]; break; }
      case 'cylinder': case 'cone': {
        const m = 28;
        for (let i = 0; i < m; i++) { const a = i * 2 * Math.PI / m; V.push([Math.cos(a), -1, Math.sin(a)]); }
        if (name === 'cylinder') { for (let i = 0; i < m; i++) { const a = i * 2 * Math.PI / m; V.push([Math.cos(a), 1, Math.sin(a)]); } for (let i = 0; i < m; i++) F.push([i, (i + 1) % m, m + (i + 1) % m, m + i]); F.push([...Array(m).keys()].map(i => m + i)); }
        else { V.push([0, 1.2, 0]); for (let i = 0; i < m; i++) F.push([i, (i + 1) % m, m]); }
        F.push([...Array(m).keys()]);
        break;
      }
      case 'sphere': {
        const la = 10, lo = 20;
        for (let i = 0; i <= la; i++) for (let j = 0; j < lo; j++) { const th = i * Math.PI / la, ph = j * 2 * Math.PI / lo; V.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]); }
        for (let i = 0; i < la; i++) for (let j = 0; j < lo; j++) { const a = i * lo + j, b = i * lo + (j + 1) % lo; F.push([a, b, b + lo, a + lo]); }
        break;
      }
      case 'torus': {
        const U = 26, W = 12, R = 0.72, r = 0.32;
        for (let i = 0; i < U; i++) for (let j = 0; j < W; j++) { const u = i * 2 * Math.PI / U, v = j * 2 * Math.PI / W; V.push([(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)]); }
        for (let i = 0; i < U; i++) for (let j = 0; j < W; j++) F.push([i * W + j, i * W + (j + 1) % W, ((i + 1) % U) * W + (j + 1) % W, ((i + 1) % U) * W + j]);
        ref = c => { const L = Math.hypot(c[0], c[2]) || 1; return [c[0] / L * R, 0, c[2] / L * R]; };
        break;
      }
    }
    const rmax = Math.max(...V.map(v => Math.hypot(...v)));
    V = V.map(v => v.map(x => x / rmax));
    const es = new Set(), E = [];
    for (const f of F) for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length]; const k = a < b ? a + ',' + b : b + ',' + a; if (!es.has(k)) { es.add(k); E.push([a, b]); } }
    return (MESH[name] = { V, F, E, ref: ref && (c => ref(c.map(x => x * rmax)).map(x => x / rmax)) });
  }
  function drawSolid(ctx, p, m, lt, pi, col, scale) {
    const yaw = (p.yaw + p.spin * lt) * Math.PI / 180, pit = (p.pitch + p.tilt * lt) * Math.PI / 180;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit);
    const rot = ([x, y, z]) => { const x1 = x * cy + z * sy, z1 = -x * sy + z * cy; return [x1, y * cp - z1 * sp, y * sp + z1 * cp]; };
    const S = p.size, dist = 4.2;
    const R = m.V.map(rot);
    const P = R.map(([x, y, z]) => { const f = p.persp ? dist / (dist - z) : 1; return [x * f * S, -y * f * S, z]; });
    const L = [-0.45, 0.62, 0.64];
    const lw = SW(2.5) / Math.max(scale, 0.05);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const fcol = color(p.color), ecol = col(color(p.edgec));
    const ff = clamp((pi - 0.25) / 0.75);
    if (p.style !== 'wire' && ff > 0) {
      const faces = m.F.map(f => {
        const c = [0, 1, 2].map(k => f.reduce((s, i) => s + R[i][k], 0) / f.length);
        const a = R[f[0]], b = R[f[1]], d = R[f[2]];
        let n = [(b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]), (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]), (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])];
        const nl = Math.hypot(...n) || 1; n = n.map(x => x / nl);
        let o = c; if (m.ref) { const rr = rot(m.ref(f.reduce((s, i) => s.map((v, k) => v + m.V[i][k] / f.length), [0, 0, 0]))); o = [c[0] - rr[0], c[1] - rr[1], c[2] - rr[2]]; }
        if (n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0) n = n.map(x => -x);
        return { f, z: c[2], n };
      }).sort((a, b) => a.z - b.z);
      for (const fc of faces) {
        if (fc.n[2] < -0.02 && !m.ref && p.fo >= 0.99) continue;
        const br = 0.28 + 0.72 * Math.max(0, fc.n[0] * L[0] + fc.n[1] * L[1] + fc.n[2] * L[2]);
        ctx.beginPath(); fc.f.forEach((i, k) => k ? ctx.lineTo(P[i][0], P[i][1]) : ctx.moveTo(P[i][0], P[i][1])); ctx.closePath();
        ctx.save(); ctx.globalAlpha *= p.fo * ff; ctx.fillStyle = col(mixColor(fcol, '#000000', 1 - br)); ctx.fill(); ctx.restore();
        if (p.style === 'both') { ctx.save(); ctx.globalAlpha *= ff * (m.F.length > 60 ? 0.35 : 0.9); ctx.strokeStyle = ecol; ctx.lineWidth = lw * (m.F.length > 60 ? 0.5 : 1); ctx.stroke(); ctx.restore(); }
      }
    }
    if (p.style === 'wire' || ff < 1) {
      const ef = clamp(pi * 1.4), n = m.E.length, show = ef * n;
      ctx.strokeStyle = ecol; ctx.lineWidth = lw * (n > 100 ? 0.55 : 1);
      for (let k = 0; k < n && k < show; k++) {
        const [a, b] = m.E[k], fr = Math.min(1, show - k);
        const back = (R[a][2] + R[b][2]) / 2 < -0.15;
        ctx.save(); ctx.globalAlpha *= (p.style === 'wire' ? (back ? 0.3 : 0.95) : (1 - ff)) ;
        ctx.beginPath(); ctx.moveTo(P[a][0], P[a][1]); ctx.lineTo(P[a][0] + (P[b][0] - P[a][0]) * fr, P[a][1] + (P[b][1] - P[a][1]) * fr); ctx.stroke(); ctx.restore();
      }
    }
  }

  // ---------- groups, text on a curve, images ----------
  TYPES.group = { label: 'Group', icon: '⧈', noCenter: true, defaults: {}, fields: [], build: () => [] };
  TYPES.textpath = {
    label: 'Curved text', icon: '⌒',
    defaults: { text: 'Text on a curve', size: 0.6, color: 'WHITE', font: 'main', style: '', shape: 'arc', bend: 0.45, amp: 0.4, waves: 1.5 },
    fields: [['text', 'Text', 'text'], ['shape', 'Curve', 'select', [['arc', 'Arc'], ['circle', 'Circle'], ['wave', 'Wave']]],
      ['bend', 'Bend (− for a smile)', 'num', 0.05, p => p.shape === 'arc'], ['amp', 'Wave height', 'num', 0.1, p => p.shape === 'wave'], ['waves', 'Waves', 'num', 0.5, p => p.shape === 'wave'],
      ['size', 'Size', 'num', 0.05], ['color', 'Colour', 'color'], ['font', 'Font', 'select', [['main', 'LaTeX serif'], ['sans', 'Sans'], ['mono', 'Mono']]], ['style', 'Style', 'select', [['', 'Regular'], ['bold', 'Bold'], ['italic', 'Italic']]]],
    build: p => {
      const chars = Array.from(String(p.text || ''));
      const gb = chars.map(ch => glyphBox(ch, p.font, p.style, p.size, color(p.color)));
      const total = gb.reduce((s, b) => s + b.w, 0) || 1;
      let pos, rot;
      if (p.shape === 'wave') {
        const k = 2 * Math.PI * Math.max(0.25, p.waves) / total, A = p.amp;
        pos = s => [s, -A * Math.sin(k * s)]; rot = s => Math.atan(-A * k * Math.cos(k * s));
      } else {
        const full = p.shape === 'circle';
        const b = full ? 1 : clamp(Math.abs(p.bend), 0.02, 1) * Math.sign(p.bend || 1);
        const R = total / (2 * Math.PI * Math.abs(b) * (full ? 0.97 : 1)), sg = Math.sign(b);
        pos = s => { const f = s / R; return [R * Math.sin(f), sg * (R - R * Math.cos(f))]; };
        rot = s => sg * s / R;
      }
      const out = [];
      let s = -total / 2;
      gb.forEach(b => {
        const mid = s + b.w / 2, [x, y] = pos(mid), r = rot(mid);
        for (const it of b.items) if (it.k === 'g') out.push(Object.assign({}, it, { x: x - Math.cos(r) * b.w / 2, y: y - Math.sin(r) * b.w / 2, rot: r }));
        s += b.w;
      });
      return out;
    }
  };
  // images are kept outside the scene (the editor loads them into this map by id)
  const IMAGES = new Map();
  TYPES.image = {
    label: 'Image', icon: '▨',
    defaults: { src: '', w: 4, ar: 0.75, border: false, color: 'WHITE', radius: 0 },
    fields: [['w', 'Width', 'num', 0.25], ['radius', 'Rounded corners', 'num', 0.05], ['border', 'Border', 'bool'], ['color', 'Border colour', 'color', null, p => p.border]],
    build: p => {
      const w = Math.max(0.1, p.w), hh = w * (p.ar || 0.75), r = clamp(p.radius || 0, 0, Math.min(w, hh) / 2);
      const shape = c => { c.beginPath(); if (r > 0 && c.roundRect) c.roundRect(-w / 2, -hh / 2, w, hh, r); else c.rect(-w / 2, -hh / 2, w, hh); };
      return [{ k: 'dyn', bb: [-w / 2, -hh / 2, w / 2, hh / 2], draw: (ctx, lt, pi, col, scale) => {
        const rec = IMAGES.get(p.src);
        ctx.save();
        shape(ctx); ctx.clip();
        if (pi < 1) { ctx.beginPath(); ctx.rect(-w / 2, -hh / 2, w * clamp(pi), hh); ctx.clip(); }
        if (rec && rec.ok) ctx.drawImage(rec.img, -w / 2, -hh / 2, w, hh);
        else { ctx.fillStyle = '#333'; ctx.fillRect(-w / 2, -hh / 2, w, hh); ctx.fillStyle = '#888'; ctx.font = '0.4px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(rec ? 'loading…' : 'image missing', 0, 0); }
        ctx.restore();
        if (p.border) { ctx.save(); shape(ctx); ctx.strokeStyle = col(color(p.color)); ctx.lineWidth = SW(4) / Math.max(scale, 0.05); ctx.stroke(); ctx.restore(); }
      } }];
    }
  };
  function setImage(id, src) {
    const img = new Image(), rec = { img, ok: false };
    IMAGES.set(id, rec);
    return new Promise(res => { img.onload = () => { rec.ok = true; res(img); }; img.onerror = () => res(null); img.src = src; });
  }

  // ---------- building with cache ----------
  const bcache = new Map();
  function build(obj) {
    const T = TYPES[obj.type];
    if (!T) return { prims: [], bb: [0, 0, 0, 0] };
    const key = obj.type + JSON.stringify(obj.props) + '|' + fontVer;
    let b = bcache.get(key);
    if (b) return b;
    let prims;
    try { prims = T.build(Object.assign({}, T.defaults, obj.props)); } catch (e) { console.warn(e); prims = []; }
    const meta = prims.meta || null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of prims) {
      if (q.k === 'p') for (const [x, y] of q.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      else if (q.k === 'g' && q.rot) { const m = meas(q.ch, q.fam, q.st), r = Math.max(m.w, m.a + m.d) * q.z; x0 = Math.min(x0, q.x - r); x1 = Math.max(x1, q.x + r); y0 = Math.min(y0, q.y - r); y1 = Math.max(y1, q.y + r); }
      else if (q.k === 'g') { const m = meas(q.ch, q.fam, q.st); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x + m.w * q.z); y0 = Math.min(y0, q.y - m.a * q.z * q.sy); y1 = Math.max(y1, q.y + m.d * q.z * q.sy); }
      else if (q.k === 'dyn') { x0 = Math.min(x0, q.bb[0]); y0 = Math.min(y0, q.bb[1]); x1 = Math.max(x1, q.bb[2]); y1 = Math.max(y1, q.bb[3]); }
      else if (q.k === 'v') { for (const [x, y, r] of q.circles) { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r); } }
    }
    if (!isFinite(x0)) { x0 = y0 = -0.5; x1 = y1 = 0.5; }
    const cx = T.noCenter ? 0 : (x0 + x1) / 2, cy = T.noCenter ? 0 : (y0 + y1) / 2;
    prims = shift(prims, -cx, -cy).map(q => {
      if (q.k === 'v') return Object.assign({}, q, { circles: q.circles.map(([x, y, r]) => [x - cx, y - cy, r]), U: q.U && [q.U[0] - cx, q.U[1] - cy, q.U[2] - cx, q.U[3] - cy] });
      if (q.k === 'tr' || q.k === 'dyn') return Object.assign({}, q, { dx: (q.dx || 0) - cx, dy: (q.dy || 0) - cy });
      return q;
    });
    for (const q of prims) if (q.k === 'p') q.len = pathLen(q.pts, q.closed);
    b = { prims, bb: [x0 - cx, y0 - cy, x1 - cx, y1 - cy], meta, cx, cy };
    if (bcache.size > 400) bcache.clear();
    bcache.set(key, b);
    return b;
  }
  function pathLen(pts, closed) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (closed && pts.length > 1) L += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
    return L;
  }

  // ---------- timing ----------
  // [id, label, group]
  const ANIM_IN = [['create', 'Create', 'Manim'], ['write', 'Write', 'Manim'], ['drawfill', 'Border then fill', 'Manim'], ['grow', 'Grow', 'Manim'], ['spin', 'Spin in', 'Manim'],
    ['fadein', 'Fade', 'Basic'], ['fadeup', 'Rise', 'Basic'], ['slideL', 'From left', 'Basic'], ['slideR', 'From right', 'Basic'], ['dropin', 'Drop in', 'Basic'], ['typewriter', 'Typewriter', 'Basic'],
    ['zoomin', 'Zoom in', 'Lively'], ['zoomout', 'Zoom out', 'Lively'], ['pop', 'Pop', 'Lively'], ['bounce', 'Bounce', 'Lively'], ['jelly', 'Jelly', 'Lively'], ['stretch', 'Stretch', 'Lively'], ['flip', 'Flip', 'Lively'], ['swing', 'Swing', 'Lively'], ['blur', 'Blur', 'Lively'],
    ['spring', 'Spring', 'Physics'], ['springL', 'Spring from left', 'Physics'], ['fallin', 'Gravity drop', 'Physics'],
    ['appear', 'None', 'Basic']];
  const ANIM_OUT = [['fadeout', 'Fade', 'Basic'], ['fadedown', 'Sink', 'Basic'], ['slideL', 'To left', 'Basic'], ['slideR', 'To right', 'Basic'], ['riseaway', 'Fly up', 'Basic'], ['typewriter', 'Untype', 'Basic'],
    ['uncreate', 'Uncreate', 'Manim'], ['shrink', 'Shrink', 'Manim'], ['transform', 'Transform into…', 'Manim'], ['transformMatch', 'Match symbols into…', 'Manim'],
    ['zoomin', 'Zoom away', 'Lively'], ['popout', 'Pop', 'Lively'], ['fall', 'Fall', 'Lively'], ['flip', 'Flip', 'Lively'], ['blur', 'Blur', 'Lively'], ['spinout', 'Spin out', 'Lively'], ['springout', 'Spring away', 'Physics'],
    ['none', 'None', 'Basic']];
  const EMPH = [['indicate', 'Indicate', 'Manim'], ['circumscribe', 'Circumscribe', 'Manim'], ['flash', 'Flash', 'Manim'], ['underline', 'Underline', 'Manim'], ['wiggle', 'Wiggle', 'Manim'],
    ['pulse', 'Pulse', 'Lively'], ['spin', 'Spin', 'Lively'], ['jelly', 'Jelly', 'Lively'], ['squash', 'Squash & stretch', 'Lively'], ['shake', 'Shake', 'Lively'], ['flip', 'Flip', 'Lively'], ['heartbeat', 'Heartbeat', 'Lively'], ['glow', 'Glow', 'Lively'], ['boing', 'Boing', 'Physics'], ['hop', 'Hop', 'Physics']];
  const LOOPS = [['none', 'None', 'Basic'], ['bob', 'Bob', 'Basic'], ['float', 'Float', 'Basic'], ['pulse', 'Pulse', 'Basic'], ['spin', 'Spin', 'Basic'], ['orbit', 'Orbit', 'Basic'],
    ['wiggle', 'Wiggle', 'Lively'], ['swing', 'Swing', 'Lively'], ['shake', 'Shake', 'Lively'], ['heartbeat', 'Heartbeat', 'Lively'], ['jelly', 'Jelly', 'Lively'], ['squash', 'Bounce & squash', 'Lively'], ['flip3d', 'Card spin', 'Lively'], ['glow', 'Glow pulse', 'Lively'], ['pendulum', 'Pendulum (set a pivot)', 'Physics'], ['hop', 'Hopping', 'Physics'], ['springy', 'Springy', 'Physics']];
  const KEYABLE = ['x', 'y', 'scale', 'sx', 'sy', 'rotation', 'opacity'];
  const KEYDEF = { x: 0, y: 0, scale: 1, sx: 1, sy: 1, rotation: 0, opacity: 1, zoom: 1 };

  function keyVal(obj, prop, t) {
    const k = obj.keys && obj.keys[prop];
    if (!k || !k.length) return obj[prop] != null ? obj[prop] : KEYDEF[prop];
    if (t <= k[0].t) return k[0].v;
    if (t >= k[k.length - 1].t) return k[k.length - 1].v;
    for (let i = 1; i < k.length; i++) if (t <= k[i].t) {
      const a = k[i - 1], b = k[i];
      if (b.ease === 'hold') return a.v;
      const u = rateFn(b.ease)((t - a.t) / (b.t - a.t || 1));
      return a.v + (b.v - a.v) * u;
    }
    return obj[prop] != null ? obj[prop] : KEYDEF[prop];
  }
  function phases(o) {
    const len = Math.max(0.01, o.end - o.start);
    const inD = o.anIn && o.anIn.type !== 'appear' ? Math.min(o.anIn.dur, len) : 0;
    const outD = o.anOut && o.anOut.type !== 'none' ? Math.min(o.anOut.dur, Math.max(0, len - inD)) : 0;
    return { inD, outD };
  }
  // V: live values at this moment (plus t, u); o.drive maps a property to a formula
  function baseState(o, t, V) {
    const s = {};
    for (const p of KEYABLE) s[p] = keyVal(o, p, t);
    if (o.drive && V) for (const [p, ex] of Object.entries(o.drive)) {
      if (!ex || KEYABLE.indexOf(p) < 0) continue;
      const v = evalExpr(ex, V);
      if (isFinite(v)) s[p] = v;
    }
    s.rotation = (s.rotation || 0) * Math.PI / 180;
    return s;
  }
  // live values (Manim's ValueTracker): scene.vars = [{ name, v, keys: [{t, v, ease}] }]
  function varsAt(scene, t) {
    const V = {};
    for (const d of scene.vars || []) if (d && d.name) V[d.name] = keyVal({ keys: { v: d.keys || [] }, v: d.v }, 'v', t);
    return V;
  }
  function camState(cam, t) { return { x: keyVal(cam, 'x', t), y: keyVal(cam, 'y', t), zoom: keyVal(cam, 'zoom', t) || 1, rotation: keyVal(cam, 'rotation', t) * Math.PI / 180 }; }
  // camera → view matrix (world units → frame units)
  function viewMat(scene, t) {
    if (!scene.camera) return I;
    const c = camState(scene.camera, t);
    return mul(mS(c.zoom, c.zoom), mul(mR(-c.rotation), mT(-c.x, -c.y)));
  }

  // ---------- drawing ----------
  // strokes the first fraction f of a polyline; returns [x, y, dx, dy] at the drawn end (for arrowheads)
  function drawPartial(ctx, pts, closed, f) {
    if (f <= 0 || pts.length < 2) return null;
    const all = closed ? pts.concat([pts[0]]) : pts;
    const n = all.length;
    if (f >= 1) { ctx.beginPath(); ctx.moveTo(all[0][0], all[0][1]); for (let i = 1; i < n; i++) ctx.lineTo(all[i][0], all[i][1]); if (closed) ctx.closePath(); ctx.stroke(); return [all[n - 1][0], all[n - 1][1], all[n - 1][0] - all[n - 2][0], all[n - 1][1] - all[n - 2][1]]; }
    let L = 0; for (let i = 1; i < n; i++) L += Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]);
    let left = L * f, end = null;
    ctx.beginPath(); ctx.moveTo(all[0][0], all[0][1]);
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]);
      const dx = all[i][0] - all[i - 1][0], dy = all[i][1] - all[i - 1][1];
      if (d >= left) { const u = left / (d || 1); const x = all[i - 1][0] + dx * u, y = all[i - 1][1] + dy * u; ctx.lineTo(x, y); end = [x, y, dx, dy]; break; }
      ctx.lineTo(all[i][0], all[i][1]); left -= d; end = [all[i][0], all[i][1], dx, dy];
    }
    ctx.stroke();
    return end;
  }
  function arrowHead(ctx, x, y, dx, dy, size) {
    const L = Math.hypot(dx, dy); if (!L) return;
    const ux = dx / L, uy = dy / L;
    ctx.beginPath(); ctx.moveTo(x + ux * size * 0.35, y + uy * size * 0.35);
    ctx.lineTo(x - ux * size * 0.75 - uy * size * 0.5, y - uy * size * 0.75 + ux * size * 0.5);
    ctx.lineTo(x - ux * size * 0.75 + uy * size * 0.5, y - uy * size * 0.75 - ux * size * 0.5);
    ctx.closePath(); ctx.fill();
  }
  function fillPath(ctx, pts) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); ctx.fill(); }

  // mode: 'full' | 'create' | 'write' | 'drawfill'; p in [0,1]
  function drawPrims(ctx, prims, mode, p, env) {
    const n = prims.length;
    const order = prims.map((q, i) => [q.ro != null ? q.ro : i, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const rank = new Array(n); order.forEach((idx, r) => { rank[idx] = r; });
    const lag = n > 1 ? clamp(1.6 / n, 0.03, 0.35) : 0;
    const d = 1 / (1 + (n - 1) * lag);
    const tint = env.tint || 0, tintC = env.tintC || PAL.YELLOW;
    const col = c => tint ? mixColor(c, tintC, tint) : c;
    const scale = env.scale || 1;
    const sty = env.style || {};
    // a gradient runs from each colour to the style's second colour, across the object
    const gcache = new Map();
    const paint = c => {
      if (!sty.grad || !env.bb) return col(c);
      let g = gcache.get(c);
      if (g) return g;
      const [x0, y0, x1, y1] = env.bb, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const a = (sty.gangle || 0) * Math.PI / 180, ux = Math.cos(a), uy = -Math.sin(a);
      const r = Math.abs((x1 - x0) / 2 * ux) + Math.abs((y1 - y0) / 2 * uy) || 1;
      g = ctx.createLinearGradient(cx - ux * r, cy - uy * r, cx + ux * r, cy + uy * r);
      g.addColorStop(0, col(c)); g.addColorStop(1, col(color(sty.grad)));
      gcache.set(c, g);
      return g;
    };
    // the same gradient, expressed in a glyph's own (moved, turned, scaled) space
    const glyphPaint = q => {
      const [x0, y0, x1, y1] = env.bb, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const a = (sty.gangle || 0) * Math.PI / 180, ux = Math.cos(a), uy = -Math.sin(a);
      const r = Math.abs((x1 - x0) / 2 * ux) + Math.abs((y1 - y0) / 2 * uy) || 1;
      const cr = Math.cos(-(q.rot || 0)), sr = Math.sin(-(q.rot || 0)), k = 100, ky = 100 / (q.sy || 1);
      const L = (x, y) => { const dx = x - q.x, dy = y - q.y; return [(dx * cr - dy * sr) * k, (dx * sr + dy * cr) * ky]; };
      const [ax, ay] = L(cx - ux * r, cy - uy * r), [bx, by] = L(cx + ux * r, cy + uy * r);
      const g = ctx.createLinearGradient(ax, ay, bx, by);
      g.addColorStop(0, col(color(q.c || '#fff'))); g.addColorStop(1, col(color(sty.grad)));
      return g;
    };
    for (let i = 0; i < n; i++) {
      const q = prims[i];
      let pi = 1;
      if (mode === 'type') pi = p * n > rank[i] + 0.5 ? 1 : 0;
      else if (mode !== 'full') pi = clamp((p - rank[i] * lag * d) / d);
      if (pi <= 0) continue;
      const a0 = ctx.globalAlpha;
      if (q.alpha != null) ctx.globalAlpha = a0 * q.alpha;
      if (env.glow) { ctx.shadowBlur = env.glow; ctx.shadowColor = env.glowC || col(q.k === 'g' ? (q.c || '#fff') : (q.stroke || q.fill || q.c || '#fff')); }
      if (q.k === 'p') {
        let sf = pi, ff = pi;
        if (mode === 'drawfill' || mode === 'write') { sf = clamp(pi * 2); ff = clamp(pi * 2 - 1); }
        else if (mode === 'create') { ff = clamp((pi - 0.3) / 0.7); }
        const doStroke = () => {
          if (!q.stroke || !q.sw) return;
          const lw = q.under ? q.sw : q.sw / Math.max(scale, 0.05);
          ctx.strokeStyle = paint(q.stroke); ctx.lineWidth = lw;
          ctx.lineJoin = 'round'; ctx.lineCap = 'round';
          if (sty.dash === 'dashed') ctx.setLineDash([lw * 3.2, lw * 2.4]);
          else if (sty.dash === 'dotted') ctx.setLineDash([0.0001, lw * 2.2]);
          const end = drawPartial(ctx, q.pts, q.closed, sf);
          if (sty.dash) ctx.setLineDash([]);
          if (sty.arrow && sty.arrow !== 'none' && !q.closed && q.pts.length > 1 && !q.under) {
            const sz = Math.max(lw * 4.5, 0.16 / Math.max(scale, 0.05));
            ctx.fillStyle = paint(q.stroke);
            if (end && (sty.arrow === 'end' || sty.arrow === 'both')) arrowHead(ctx, ...end, sz);
            if (sty.arrow === 'start' || sty.arrow === 'both') { const a = q.pts[0], b = q.pts[1]; arrowHead(ctx, a[0], a[1], a[0] - b[0], a[1] - b[1], sz); }
          }
        };
        if (q.under) doStroke();
        if (q.fill && q.fo > 0 && ff > 0) { ctx.save(); ctx.globalAlpha *= q.fo * ff; ctx.fillStyle = paint(q.fill); fillPath(ctx, q.pts); ctx.restore(); }
        if (!q.under) doStroke();
        else if (q.under && sf < 1 && ff <= 0) { /* outline still drawing */ }
      } else if (q.k === 'g') {
        ctx.save();
        ctx.translate(q.x, q.y); if (q.rot) ctx.rotate(q.rot); ctx.scale(0.01, 0.01 * (q.sy || 1));
        ctx.font = fontCss(q.st, Math.round(q.z * 100 * 100) / 100, q.fam);
        const c = sty.grad && env.bb ? glyphPaint(q) : col(q.c || '#fff');
        if (pi < 1) {
          const D = q.z * 100 * 5;
          ctx.setLineDash([D * clamp(pi * 1.6), D * 2]);
          ctx.lineWidth = q.z * 100 * 0.025; ctx.strokeStyle = c;
          ctx.strokeText(q.ch, 0, 0);
          ctx.setLineDash([]);
          const fa = clamp((pi - 0.45) / 0.55);
          if (fa > 0) { ctx.globalAlpha *= fa; ctx.fillStyle = c; ctx.fillText(q.ch, 0, 0); }
        } else { ctx.fillStyle = c; ctx.fillText(q.ch, 0, 0); }
        ctx.restore();
      } else if (q.k === 'v') {
        drawVenn(ctx, q, pi, col);
      } else if (q.k === 'dyn') {
        ctx.save(); ctx.translate(q.dx || 0, q.dy || 0);
        q.draw(ctx, env.lt || 0, pi, col, scale, env);
        ctx.restore();
      } else if (q.k === 'tr' && env.u != null) {
        const x = q.xmin + (q.xmax - q.xmin) * clamp(env.u);
        let y; try { y = q.f(x); } catch (e) { y = NaN; }
        if (isFinite(y) && y >= q.ymin && y <= q.ymax) {
          const px = q.X(x) + q.dx, py = q.Y(y) + q.dy;
          ctx.save(); ctx.globalAlpha *= pi;
          ctx.strokeStyle = col(q.c); ctx.globalAlpha *= 0.5; ctx.setLineDash([0.06, 0.06]); ctx.lineWidth = 0.015;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, q.Y(clamp(0, q.ymin, q.ymax)) + q.dy); ctx.stroke(); ctx.setLineDash([]);
          ctx.globalAlpha /= 0.5;
          ctx.fillStyle = col('#FFFF00'); ctx.beginPath(); ctx.arc(px, py, 0.09, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }
      ctx.globalAlpha = a0;
    }
    if (env.glow) { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; }
  }
  function drawVenn(ctx, q, pi, col) {
    const a = clamp(pi);
    if (!q.terms.length || a <= 0) return;
    const U = q.U || [-50, -50, 50, 50];
    ctx.save();
    ctx.globalAlpha *= q.fo * a;
    ctx.fillStyle = col(q.c);
    for (const m of q.terms) {
      ctx.save();
      ctx.beginPath(); ctx.rect(U[0], U[1], U[2] - U[0], U[3] - U[1]); ctx.clip();
      q.circles.forEach(([x, y, r], i) => {
        ctx.beginPath();
        if (m >> i & 1) { ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip(); }
        else { ctx.rect(U[0] - 1, U[1] - 1, U[2] - U[0] + 2, U[3] - U[1] + 2); ctx.arc(x, y, r, 0, Math.PI * 2, true); ctx.clip('evenodd'); }
      });
      ctx.fillRect(U[0], U[1], U[2] - U[0], U[3] - U[1]);
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------- morphing (Transform and TransformMatchingTex) ----------
  function resample(pts, closed, N) {
    const all = closed ? pts.concat([pts[0]]) : pts;
    const cum = [0];
    for (let i = 1; i < all.length; i++) cum.push(cum[i - 1] + Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]));
    const L = cum[cum.length - 1] || 1, out = [];
    let j = 1;
    for (let k = 0; k < N; k++) {
      const d = L * k / (closed ? N : N - 1);
      while (j < all.length - 1 && cum[j] < d) j++;
      const seg = cum[j] - cum[j - 1] || 1, u = clamp((d - cum[j - 1]) / seg);
      out.push([all[j - 1][0] + (all[j][0] - all[j - 1][0]) * u, all[j - 1][1] + (all[j][1] - all[j - 1][1]) * u]);
    }
    return out;
  }
  // point at fraction u along a polyline: [x, y, dx, dy]
  function pointAt(q, u) {
    const all = q.closed ? q.pts.concat([q.pts[0]]) : q.pts;
    if (!q._cum) { const c = [0]; for (let i = 1; i < all.length; i++) c.push(c[i - 1] + Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1])); q._cum = c; }
    const c = q._cum, L = c[c.length - 1] || 1, d = L * clamp(u);
    let i = 1; while (i < c.length - 1 && c[i] < d) i++;
    const seg = c[i] - c[i - 1] || 1, k = clamp((d - c[i - 1]) / seg);
    const a = all[i - 1], b = all[i];
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, b[0] - a[0], b[1] - a[1]];
  }
  // M: the object's frame matrix (view · world); parts come out in frame units
  function morphParts(obj, M, zoom, opacity) {
    const b = build(obj), sc = mdet(M), MF = mul(M, FLIP);
    const ang = Math.atan2(M[1], M[0]);
    const paths = [], glyphs = [];
    for (const q of b.prims) {
      if (q.k === 'p') paths.push({ pts: resample(q.pts, q.closed, 80).map(([x, y]) => ap(MF, x, y)), closed: q.closed, stroke: q.stroke, sw: q.sw * zoom, fill: q.fill, fo: q.fill ? q.fo : 0, alpha: (q.alpha == null ? 1 : q.alpha) });
      else if (q.k === 'g') { const [x, y] = ap(MF, q.x, q.y); glyphs.push({ ch: q.ch, fam: q.fam, st: q.st, z: q.z * sc, x, y, c: q.c, sy: q.sy, rot: (q.rot || 0) - ang }); }
    }
    return { paths, glyphs, opacity };
  }
  function bestShift(A, B) {
    let best = 0, bd = Infinity;
    for (let s = 0; s < A.length; s += 4) { let d = 0; for (let i = 0; i < A.length; i += 8) { const b = B[(i + s) % B.length]; d += Math.hypot(A[i][0] - b[0], A[i][1] - b[1]); } if (d < bd) { bd = d; best = s; } }
    return best;
  }
  function drawMorph(ctx, A, B, u, ppu, W, H, match) {
    const S = ([x, y]) => [W / 2 + x * ppu, H / 2 - y * ppu];
    const lerp = (a, b) => a + (b - a) * u;
    const cen = ps => { let x = 0, y = 0; ps.forEach(p => { x += p[0]; y += p[1]; }); return [x / ps.length, y / ps.length]; };
    const n = Math.max(A.paths.length, B.paths.length);
    const op = lerp(A.opacity, B.opacity);
    for (let i = 0; i < n; i++) {
      let a = A.paths[i], b = B.paths[i];
      if (!a) { const ref = A.paths[A.paths.length - 1]; a = ref ? Object.assign({}, b, { pts: b.pts.map(() => cen(ref.pts)), fo: 0, alpha: 0 }) : Object.assign({}, b, { alpha: 0 }); }
      if (!b) { const ref = B.paths[B.paths.length - 1]; b = ref ? Object.assign({}, a, { pts: a.pts.map(() => cen(ref.pts)), fo: 0, alpha: 0 }) : Object.assign({}, a, { alpha: 0 }); }
      let bp = b.pts;
      if (a.closed && b.closed) { const s = bestShift(a.pts, b.pts); bp = b.pts.map((_, k) => b.pts[(k + s) % b.pts.length]); }
      const pts = a.pts.map((p, k) => S([lerp(p[0], bp[k][0]), lerp(p[1], bp[k][1])]));
      ctx.save();
      ctx.globalAlpha = op * lerp(a.alpha, b.alpha);
      const fo = lerp(a.fill ? a.fo : 0, b.fill ? b.fo : 0);
      const closed = u < 0.5 ? a.closed : b.closed;
      if (fo > 0 && closed) { ctx.save(); ctx.globalAlpha *= fo; ctx.fillStyle = mixColor(a.fill || b.fill, b.fill || a.fill, u); fillPath(ctx, pts); ctx.restore(); }
      const sc = a.stroke || b.stroke;
      if (sc) { ctx.strokeStyle = mixColor(a.stroke || b.stroke, b.stroke || a.stroke, u); ctx.lineWidth = lerp(a.sw || 0, b.sw || 0) * ppu; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; drawPartial(ctx, pts, closed, 1); }
      ctx.restore();
    }
    const drawG = (g, x, y, z, rot, c, alpha) => {
      if (alpha <= 0.002) return;
      const [sx, sy] = S([x, y]);
      ctx.save(); ctx.globalAlpha = op * alpha; ctx.translate(sx, sy); if (rot) ctx.rotate(rot); ctx.scale(ppu / 100, ppu / 100 * (g.sy || 1));
      ctx.font = fontCss(g.st, Math.round(z * 10000) / 100, g.fam); ctx.fillStyle = c; ctx.fillText(g.ch, 0, 0); ctx.restore();
    };
    // pair glyphs: by position (Transform) or by matching symbols (TransformMatchingTex)
    const pairs = [];
    if (match) {
      const used = new Set();
      for (const a of A.glyphs) {
        let j = -1;
        for (let k = 0; k < B.glyphs.length; k++) if (!used.has(k) && B.glyphs[k].ch === a.ch && B.glyphs[k].fam === a.fam) { j = k; break; }
        if (j >= 0) { used.add(j); pairs.push([a, B.glyphs[j]]); } else pairs.push([a, null]);
      }
      B.glyphs.forEach((b, k) => { if (!used.has(k)) pairs.push([null, b]); });
    } else for (let i = 0; i < Math.max(A.glyphs.length, B.glyphs.length); i++) pairs.push([A.glyphs[i], B.glyphs[i]]);
    for (const [a, b] of pairs) {
      if (a && b) {
        const x = lerp(a.x, b.x), y = lerp(a.y, b.y), z = lerp(a.z, b.z), r = lerp(a.rot || 0, b.rot || 0), c = mixColor(a.c || '#fff', b.c || '#fff', u);
        if (a.ch === b.ch && a.fam === b.fam) drawG(a, x, y, z, r, c, 1);
        else { drawG(a, x, y, z, r, c, 1 - u); drawG(b, x, y, z, r, c, u); }
      } else if (a) drawG(a, a.x, a.y, a.z, a.rot, a.c || '#fff', match ? 1 - clamp(u * 2) : 1 - u);
      else drawG(b, b.x, b.y, b.z, b.rot, b.c || '#fff', match ? clamp(u * 2 - 1) : u);
    }
  }

  const isMorph = o => !!(o.anOut && (o.anOut.type === 'transform' || o.anOut.type === 'transformMatch'));
  // One object's own state at time t: keyframes, formulas, then in/out animations, effects and loops.
  function frameState(o, t, V0, atEnd, sceneDur) {
    const len = Math.max(0.01, o.end - o.start);
    const V = Object.assign({}, V0, { t, u: clamp((t - o.start) / len) });
    const st = baseState(o, t, V);
    const f = { st, mode: 'full', p: 1, blur: 0, glowBoost: 0, morph: null, extras: [], V, tint: 0, tintC: null, lt: t - o.start, u: 1 };
    f.vis = !(t < o.start || (t >= o.end && !(atEnd && o.end >= sceneDur - 1e-6 && o.anOut.type === 'none')));
    if (!f.vis) return f;
    const { inD, outD } = phases(o);
    if (inD && t < o.start + inD) {
      const raw = clamp((t - o.start) / inD), e = rateFn(o.anIn.rate)(raw);
      switch (o.anIn.type) {
        case 'create': f.mode = 'create'; f.p = e; break;
        case 'write': f.mode = 'write'; f.p = rateFn(o.anIn.rate, 'linear')(raw); break;
        case 'drawfill': f.mode = 'drawfill'; f.p = e; break;
        case 'typewriter': f.mode = 'type'; f.p = raw; break;
        case 'fadein': st.opacity *= e; break;
        case 'fadeup': st.opacity *= e; st.y -= (1 - e) * 0.6; break;
        case 'grow': st.scale *= Math.max(e, 0.001); break;
        case 'spin': st.scale *= Math.max(e, 0.001); st.rotation += (1 - e) * Math.PI; break;
        case 'slideL': st.x -= (1 - e) * 3; st.opacity *= clamp(raw * 2.5); break;
        case 'slideR': st.x += (1 - e) * 3; st.opacity *= clamp(raw * 2.5); break;
        case 'dropin': st.y += (1 - e) * 2.5; st.opacity *= clamp(raw * 2.5); break;
        case 'zoomin': st.scale *= 0.25 + 0.75 * e; st.opacity *= e; break;
        case 'zoomout': st.scale *= 1 + 1.8 * (1 - e); st.opacity *= e; break;
        case 'pop': st.scale *= Math.max(0.001, RATE.backOut(raw)); st.opacity *= clamp(raw * 4); break;
        case 'bounce': st.y += (1 - RATE.bounce(raw)) * 3; st.opacity *= clamp(raw * 4); break;
        case 'jelly': st.sx *= Math.max(0.001, RATE.elastic(raw)); st.sy *= Math.max(0.001, RATE.elastic(clamp(raw * 1.15 - 0.08))); break;
        case 'stretch': st.sy *= Math.max(0.001, RATE.backOut(raw)); st.sx *= 1 + 0.35 * (1 - raw) * (1 - raw); st.opacity *= clamp(raw * 3); break;
        case 'flip': st.sx *= Math.max(0.001, Math.sin(e * Math.PI / 2)); break;
        case 'swing': st.rotation += 0.9 * (1 - RATE.elastic(raw)); st.opacity *= clamp(raw * 3); break;
        case 'blur': f.blur = (1 - e) * 24; st.opacity *= e; break;
        case 'spring': st.scale *= Math.max(0.001, RATE.spring(raw)); st.opacity *= clamp(raw * 6); break;
        case 'springL': st.x -= (1 - RATE.spring(raw)) * 3; st.opacity *= clamp(raw * 6); break;
        case 'fallin': {
          const g = raw < 0.62 ? Math.pow(raw / 0.62, 2) : 1;
          st.y += (1 - g) * 4.5; st.opacity *= clamp(raw * 6);
          if (raw >= 0.62) { const k = (raw - 0.62) / 0.38, sq = Math.sin(k * Math.PI * 2) * 0.28 * (1 - k); st.sy *= 1 - sq; st.sx *= 1 + sq; }
          break;
        }
      }
    }
    if (outD && t >= o.end - outD) {
      const raw = clamp((t - (o.end - outD)) / outD), e = rateFn(o.anOut.rate)(raw);
      switch (o.anOut.type) {
        case 'fadeout': st.opacity *= 1 - e; break;
        case 'fadedown': st.opacity *= 1 - e; st.y -= e * 0.6; break;
        case 'uncreate': f.mode = 'create'; f.p = 1 - e; break;
        case 'typewriter': f.mode = 'type'; f.p = 1 - raw; break;
        case 'shrink': st.scale *= Math.max(1 - e, 0.001); break;
        case 'transform': case 'transformMatch': f.morph = { tgt: o.anOut.target, e, match: o.anOut.type === 'transformMatch' }; break;
        case 'slideL': st.x -= e * 3; st.opacity *= 1 - clamp(raw * 2.5 - 1.5); break;
        case 'slideR': st.x += e * 3; st.opacity *= 1 - clamp(raw * 2.5 - 1.5); break;
        case 'riseaway': st.y += e * 2.5; st.opacity *= 1 - clamp(raw * 2.5 - 1.5); break;
        case 'zoomin': st.scale *= 1 + 1.8 * e; st.opacity *= 1 - e; break;
        case 'popout': st.scale *= Math.max(0.001, 1 - RATE.backIn(raw)); break;
        case 'fall': st.y -= raw * raw * 5; st.rotation -= raw * raw * 0.9; st.opacity *= 1 - raw * raw; break;
        case 'flip': st.sx *= Math.max(0.001, Math.cos(e * Math.PI / 2)); break;
        case 'blur': f.blur = e * 24; st.opacity *= 1 - e; break;
        case 'spinout': st.scale *= Math.max(1 - e, 0.001); st.rotation -= e * Math.PI; break;
        case 'springout': { const k = RATE.spring(1 - raw); st.scale *= Math.max(0.001, k); break; }
      }
    }
    for (const em of o.emph || []) {
      if (t < em.t || t > em.t + em.dur) continue;
      const e = clamp((t - em.t) / em.dur), b = RATE.thereAndBack(e);
      switch (em.type) {
        case 'indicate': st.scale *= 1 + 0.2 * b; f.tint = b; f.tintC = color(em.color) || PAL.YELLOW; break;
        case 'wiggle': st.rotation += 0.12 * Math.sin(e * 6 * Math.PI) * b; st.scale *= 1 + 0.1 * b; break;
        case 'pulse': st.scale *= 1 + 0.12 * Math.abs(Math.sin(e * 2 * Math.PI)); break;
        case 'spin': st.rotation += 2 * Math.PI * RATE.smooth(e); break;
        case 'jelly': { const w = Math.sin(e * 6 * Math.PI) * (1 - e) * 0.28; st.sx *= 1 + w; st.sy *= 1 - w; break; }
        case 'squash': { const w = Math.sin(e * 2 * Math.PI) * (1 - e * 0.5) * 0.3; st.sy *= 1 - w; st.sx *= 1 + w; break; }
        case 'shake': st.x += 0.12 * Math.sin(e * 44) * (1 - e); break;
        case 'flip': st.sx *= Math.cos(e * 2 * Math.PI) || 0.001; break;
        case 'heartbeat': st.scale *= 1 + 0.16 * Math.max(0, Math.sin(e * 4 * Math.PI)) * (1 - e * 0.4); break;
        case 'glow': f.glowBoost = Math.max(f.glowBoost, b); break;
        case 'boing': { const w = Math.exp(-4.5 * e) * Math.sin(e * Math.PI * 8) * 0.32; st.sx *= 1 + w; st.sy *= 1 - w; break; }
        case 'hop': { const k = clamp(e / 0.8); st.y += 4 * k * (1 - k) * 0.9; if (e > 0.8) { const q = Math.sin((e - 0.8) / 0.2 * Math.PI) * 0.22; st.sy *= 1 - q; st.sx *= 1 + q; } break; }
        case 'circumscribe': case 'flash': case 'underline': f.extras.push([em, e]); break;
      }
    }
    const lt = f.lt;
    switch (o.loop) {
      case 'bob': st.y += 0.12 * Math.sin(lt * 2 * Math.PI / 1.6); break;
      case 'pulse': st.scale *= 1 + 0.06 * Math.sin(lt * 2 * Math.PI / 1.2); break;
      case 'spin': st.rotation -= lt * 0.9; break;
      case 'wiggle': st.rotation += 0.1 * Math.sin(lt * 2 * Math.PI * 1.3); break;
      case 'float': st.y += 0.08 * Math.sin(lt * 1.7); st.rotation += 0.05 * Math.sin(lt * 1.1); break;
      case 'orbit': st.x += 0.25 * Math.cos(lt * 2); st.y += 0.25 * Math.sin(lt * 2); break;
      case 'swing': st.rotation += 0.22 * Math.sin(lt * 2.4); break;
      case 'shake': st.x += 0.035 * Math.sin(lt * 41); st.y += 0.03 * Math.sin(lt * 33); break;
      case 'heartbeat': { const ph = (lt * 1.2) % 1; st.scale *= 1 + 0.1 * (Math.exp(-Math.pow((ph - 0.1) * 14, 2)) + 0.7 * Math.exp(-Math.pow((ph - 0.32) * 14, 2))); break; }
      case 'jelly': { const w = 0.07 * Math.sin(lt * 5); st.sx *= 1 + w; st.sy *= 1 - w; break; }
      case 'squash': { const ph = Math.abs(Math.sin(lt * 3)); st.y += ph * 0.6; const sq = Math.pow(1 - ph, 6) * 0.25; st.sy *= 1 - sq; st.sx *= 1 + sq; break; }
      case 'flip3d': st.sx *= Math.cos(lt * 2.5) || 0.001; break;
      case 'glow': f.glowBoost = Math.max(f.glowBoost, 0.5 + 0.5 * Math.sin(lt * 3)); break;
      case 'pendulum': st.rotation += 0.5 * Math.sin(lt * Math.PI) * Math.max(0.35, Math.exp(-lt * 0.05)); break;
      case 'hop': { const ph = (lt * 1.25) % 1; st.y += 4 * ph * (1 - ph) * 0.7; const q = Math.exp(-Math.pow(Math.min(ph, 1 - ph) * 14, 2)) * 0.22; st.sy *= 1 - q; st.sx *= 1 + q; break; }
      case 'springy': { const ph = (lt * 0.7) % 1; const w = Math.exp(-5 * ph) * Math.sin(ph * Math.PI * 10) * 0.12; st.sx *= 1 + w; st.sy *= 1 - w; break; }
    }
    const mid = o.start + inD, endMove = o.end - outD;
    f.u = endMove > mid ? (t - mid) / (endMove - mid) : 1;
    return f;
  }
  // world matrix of an object at rest (keyframes only), through its parents
  function restWorld(scene, o, t, depth) {
    depth = depth || 0;
    const V = Object.assign(varsAt(scene, t), { t, u: 0 });
    const st = baseState(o, t, V), pv = o.pivot || [0, 0];
    const L = mul(mT(st.x, st.y), mul(mR(st.rotation), mul(mS(st.scale * st.sx, st.scale * st.sy), mT(-pv[0], -pv[1]))));
    const par = o.parent && scene.objects.find(x => x.id === o.parent);
    return par && depth < 24 ? mul(restWorld(scene, par, t, depth + 1), L) : L;
  }

  // Render one frame of the scene at time t onto ctx (W×H pixels).
  // opt.guides: also draw hidden guide objects faintly (the editor does this)
  function render(ctx, scene, t, W, H, opt) {
    const ppu = H / 8;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = scene.bg || '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    const objs = scene.objects;
    const byId = {}; for (const o of objs) byId[o.id] = o;
    const V0 = varsAt(scene, t), names = Object.keys(V0);
    const view = viewMat(scene, t), zoom = mdet(view);
    const SCR = [ppu, 0, 0, -ppu, W / 2, H / 2];
    const hidden = new Set();
    for (const o of objs) if (isMorph(o) && byId[o.anOut.target] && t >= o.end - phases(o).outD && t < o.end) hidden.add(o.anOut.target);
    const atEnd = t >= scene.duration - 1e-6;
    const F = new Map();
    for (const o of objs) { o._hit = null; F.set(o.id, frameState(o, t, V0, atEnd, scene.duration)); }
    const eff = new Map();
    const effOf = o => { let e = eff.get(o.id); if (!e) { e = effProps(o, Object.assign({}, V0, { t, u: F.get(o.id).V.u }), names); eff.set(o.id, e); } return e; };
    // world matrices: parents, attachments to a graph, and motion paths
    const Wd = new Map();
    function graphPoint(g, o, f, depth) {
      const gw = world(g, depth + 1), gb = build(effOf(g)), m = gb.meta;
      if (!m) return null;
      const fn = o.attach.fn === 2 ? m.f2 : m.f1;
      if (!fn) return null;
      const V = Object.assign({}, f.V, { xmin: m.xmin, xmax: m.xmax });
      let x = o.attach.x == null || String(o.attach.x).trim() === '' ? m.xmin + (m.xmax - m.xmin) * rateFn(o.attach.ease || 'smooth')(f.V.u) : evalExpr(String(o.attach.x), V);
      if (!isFinite(x)) x = 0;
      x = clamp(x, m.xmin, m.xmax);
      const yAt = xx => { try { return fn(xx, V); } catch (e) { return NaN; } };
      const y = yAt(x);
      if (!isFinite(y)) return null;
      const GM = mul(gw.M, FLIP);
      const loc = (xx, yy) => ap(GM, m.X(xx) - gb.cx, m.Y(clamp(yy, m.ymin, m.ymax)) - gb.cy);
      const P = loc(x, y);
      let rot = 0;
      if (o.attach.tilt) { const hh = (m.xmax - m.xmin) / 2000, P2 = loc(x + hh, yAt(x + hh)); rot = Math.atan2(P2[1] - P[1], P2[0] - P[0]); }
      return [P[0], P[1], rot];
    }
    function pathPoint(po, o, f, depth) {
      const pw = world(po, depth + 1), pb = build(effOf(po));
      let best = null;
      for (const q of pb.prims) if (q.k === 'p' && q.pts.length > 1 && (!best || (q.len || 0) > (best.len || 0))) best = q;
      if (!best) return null;
      const pd = o.path;
      let u = rateFn(pd.ease || 'smooth')(f.V.u);
      if (pd.reverse) u = 1 - u;
      const pt = pointAt(best, u), GM = mul(pw.M, FLIP);
      const P = ap(GM, pt[0], pt[1]), D = apv(GM, pt[2], pt[3]);
      return [P[0], P[1], pd.orient ? Math.atan2(D[1], D[0]) : 0];
    }
    function world(o, depth) {
      let w = Wd.get(o.id);
      if (w) return w;
      Wd.set(o.id, { M: I, base: I, sc: 1, op: 1, vis: true });
      const f = F.get(o.id), st = f.st;
      let base = I, sc = 1, op = 1, vis = f.vis, extraRot = 0;
      const at = o.attach && byId[o.attach.to], pa = o.path && byId[o.path.to], par = o.parent && byId[o.parent];
      if (depth < 24 && at && at !== o) { const g = graphPoint(at, o, f, depth); if (g) { base = mT(g[0], g[1]); extraRot = g[2]; } }
      else if (depth < 24 && pa && pa !== o) { const g = pathPoint(pa, o, f, depth); if (g) { base = mT(g[0], g[1]); extraRot = g[2]; } }
      else if (depth < 24 && par && par !== o) { const pw = world(par, depth + 1); base = pw.M; sc = pw.sc; op = pw.op; vis = vis && pw.vis; }
      const pv = o.pivot || [0, 0];
      const L = mul(mT(st.x, st.y), mul(mR(st.rotation + extraRot), mul(mS(st.scale * st.sx, st.scale * st.sy), mT(-pv[0], -pv[1]))));
      w = { M: mul(base, L), base, sc: sc * Math.abs(st.scale), op: op * clamp(st.opacity), vis };
      Wd.set(o.id, w);
      return w;
    }
    // a group's box wraps its members
    const gbb = new Map();
    function groupBB(g, depth) {
      if (gbb.has(g.id)) return gbb.get(g.id) || [-0.5, -0.5, 0.5, 0.5];
      gbb.set(g.id, null);
      const Mi = inv(world(g, 0).M);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of objs) if (c.parent === g.id && c !== g && depth < 24) {
        const bb = c.type === 'group' ? groupBB(c, depth + 1) : build(effOf(c)).bb;
        const T = mul(Mi, mul(world(c, 0).M, FLIP));
        for (const [x, y] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]]) { const [a, b] = ap(T, x, y); x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, -b); y1 = Math.max(y1, -b); }
      }
      const r = isFinite(x0) ? [x0, y0, x1, y1] : [-0.5, -0.5, 0.5, 0.5];
      gbb.set(g.id, r);
      return r;
    }
    for (const o of objs) {
      const f = F.get(o.id), w = world(o, 0);
      if (!w.vis) continue;
      const P = mul(view, w.M), base = mul(view, w.base);
      if (o.type === 'group') { o._hit = { P, base, bb: groupBB(o, 0), sc: w.sc * zoom, group: true }; continue; }
      if (hidden.has(o.id)) continue;
      let guideA = 1;
      if (o.hidden) { if (!(opt && opt.guides)) { o._hit = { P, base, bb: build(effOf(o)).bb, sc: w.sc * zoom, guide: true }; continue; } guideA = 0.3; }
      if (f.morph && byId[f.morph.tgt]) {
        const tg = byId[f.morph.tgt];
        const A = morphParts(effOf(o), P, zoom, w.op);
        const B = morphParts(effOf(tg), mul(view, restWorld(scene, tg, tg.start)), zoom, keyVal(tg, 'opacity', tg.start));
        drawMorph(ctx, A, B, f.morph.e, ppu, W, H, f.morph.match);
        continue;
      } else if (f.morph) w.op *= 1 - f.morph.e;
      if (w.op <= 0.001) continue;
      const b = build(effOf(o));
      const env = { scale: w.sc, u: f.u, lt: f.lt, style: o.style || null, bb: b.bb, tint: f.tint, tintC: f.tintC };
      const gl = clamp((o.glow || 0) + f.glowBoost * 0.8, 0, 1.5);
      if (gl > 0) { env.glow = gl * H * 0.03; env.glowC = o.glowColor ? color(o.glowColor) : null; }
      const full = mul(SCR, mul(P, FLIP));
      ctx.save();
      ctx.setTransform(full[0], full[1], full[2], full[3], full[4], full[5]);
      ctx.globalAlpha = clamp(w.op) * guideA;
      if (f.blur > 0.3) ctx.filter = 'blur(' + (f.blur * H / 1080).toFixed(1) + 'px)';
      drawPrims(ctx, b.prims, f.mode, f.p, env);
      if (gl > 0.6) { env.glow *= 0.5; drawPrims(ctx, b.prims, f.mode, f.p, env); }
      ctx.filter = 'none';
      for (const [em, e] of f.extras) drawExtra(ctx, em, e, b.bb, w.sc);
      ctx.restore();
      o._hit = { P, base, bb: b.bb, sc: w.sc * zoom };
    }
    ctx.restore();
  }
  function drawExtra(ctx, em, e, bb, scale) {
    const c = color(em.color) || PAL.YELLOW;
    const [x0, y0, x1, y1] = bb, pad = 0.15 / scale;
    ctx.save();
    ctx.strokeStyle = c; ctx.lineWidth = 0.035 / scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (em.type === 'circumscribe') {
      const pts = [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]];
      if (e < 0.5) drawPartial(ctx, pts, true, e * 2);
      else { const r = resample(pts, true, 160); const k = Math.floor((e - 0.5) * 2 * 160); drawPartial(ctx, r.slice(k), false, 1); }
    } else if (em.type === 'underline') {
      const y = y1 + pad;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + (x1 - x0) * clamp(e * 1.6), y); ctx.globalAlpha *= e > 0.75 ? 1 - (e - 0.75) / 0.25 : 1; ctx.stroke();
    } else if (em.type === 'flash') {
      const R = Math.max(x1 - x0, y1 - y0) / 2 + pad;
      const r1 = R + e * 0.9 / scale, r0 = R + Math.max(0, e - 0.35) * 1.2 / scale;
      ctx.globalAlpha *= 1 - e * 0.6;
      for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke(); }
    }
    ctx.restore();
  }

  // Frame units (y up) ↔ an object's local primitive units (y down), using the last render.
  const toLocalPt = (o, ux, uy) => { const h = o._hit; if (!h) return null; const [x, y] = ap(inv(h.P), ux, uy); return [x, -y]; };
  const toFramePt = (o, lx, ly) => { const h = o._hit; if (!h) return null; return ap(h.P, lx, -ly); };
  // Hit test in frame units. Returns the topmost drawn object (groups and hidden guides are skipped).
  function hitTest(scene, ux, uy) {
    for (let i = scene.objects.length - 1; i >= 0; i--) {
      const o = scene.objects[i], h = o._hit;
      if (!h || h.group || h.guide) continue;
      const [lx, ly] = toLocalPt(o, ux, uy), bb = h.bb;
      const pad = 0.15 / Math.max(0.05, h.sc || 1);
      if (lx >= bb[0] - pad && lx <= bb[2] + pad && ly >= bb[1] - pad && ly <= bb[3] + pad) return o;
    }
    return null;
  }

  function fontsChanged() { mcache = new Map(); bcache.clear(); fontVer++; }
  let fontVer = 0;

  const MAT = { I, mul, ap, apv, inv, mT, mR, mS, mdet, FLIP };
  window.Animath = { KEYDEF, drawPrims, PAL, TYPES, ANIM_IN, ANIM_OUT, EMPH, LOOPS, KEYABLE, RATE, rateFn, render, hitTest, build, phases, keyVal, color, fontsChanged, compileFn, parseSet, parseLogic, parseTex, texBox,
    MAT, toLocalPt, toFramePt, restWorld, varsAt, viewMat, camState, evalExpr, effProps, subst, RESERVED, IMAGES, setImage, isMorph, frameState };
})();
