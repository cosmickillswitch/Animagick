/* Animath → Manim Community Python. Builds a Scene class that recreates the timeline as closely as
   Manim allows. Objects Manim has no equivalent for become labelled placeholders, and timings that
   overlap in Animath are played one after another, with a comment saying so. */
window.AnimathCode = (function () {
  'use strict';
  const A = window.Animath, M = A.MAT;
  const MCOL = { WHITE: 'WHITE', GREY: 'GREY', BLUE: 'BLUE', TEAL: 'TEAL', GREEN: 'GREEN', YELLOW: 'YELLOW', GOLD: 'GOLD', ORANGE: 'ORANGE', RED: 'RED', MAROON: 'MAROON', PURPLE: 'PURPLE', PINK: 'PINK', BLACK: 'BLACK', BLUE_E: 'BLUE_E', GREEN_E: 'GREEN_E' };
  const col = c => { if (!c) return 'WHITE'; const u = String(c).toUpperCase(); return MCOL[u] || JSON.stringify(A.color(c) || c); };
  const n = v => { const r = Math.round((+v || 0) * 1000) / 1000; return String(Object.is(r, -0) ? 0 : r); };
  const pt = (x, y) => '[' + n(x) + ', ' + n(y) + ', 0]';
  const raw = s => { s = String(s); return s.includes('"') ? "r'''" + s + "'''" : 'r"' + s + '"'; };
  const str = s => JSON.stringify(String(s));
  const RATES = { linear: 'linear', easeIn: 'rate_functions.ease_in_cubic', easeOut: 'rate_functions.ease_out_cubic', backOut: 'rate_functions.ease_out_back', backIn: 'rate_functions.ease_in_back', bounce: 'rate_functions.ease_out_bounce', elastic: 'rate_functions.ease_out_elastic', spring: 'rate_functions.ease_out_elastic', gravity: 'rate_functions.ease_in_quad', snap: 'rate_functions.ease_out_expo', thereAndBack: 'there_and_back' };
  const rateArg = r => RATES[r] ? ', rate_func=' + RATES[r] : '';

  // maths formula → numpy (best effort: implicit products, ^, and the usual functions)
  function pyFn(src, v) {
    const s = String(src || '').replace(/π/g, 'pi').replace(/−/g, '-').replace(/×|·/g, '*');
    const fn = { sin: 'np.sin', cos: 'np.cos', tan: 'np.tan', asin: 'np.arcsin', acos: 'np.arccos', atan: 'np.arctan', sinh: 'np.sinh', cosh: 'np.cosh', tanh: 'np.tanh', exp: 'np.exp', ln: 'np.log', log: 'np.log10', log10: 'np.log10', log2: 'np.log2', sqrt: 'np.sqrt', abs: 'np.abs', floor: 'np.floor', ceil: 'np.ceil', round: 'np.round', sign: 'np.sign', min: 'min', max: 'max', pow: 'pow', sec: '1/np.cos', csc: '1/np.sin', cot: '1/np.tan' };
    const consts = { pi: 'np.pi', e: 'np.e' };
    const toks = s.match(/\d*\.?\d+(?:e[+-]?\d+)?|[A-Za-z_]\w*|\*\*|\S/g) || [];
    let out = '', prev = '';
    for (const t of toks) {
      const isNum = /^\d|^\./.test(t), isId = /^[A-Za-z_]/.test(t);
      const prevVal = /^\d|^\.|\)$/.test(prev) || (/^[A-Za-z_]/.test(prev) && !fn[prev]);
      if (prevVal && (isNum || isId || t === '(')) out += '*';
      if (isId) out += fn[t] || consts[t] || (t === (v || 'x') ? t : VARS.has(t) ? t + '.get_value()' : t);
      else out += t === '^' ? '**' : t;
      prev = t;
    }
    return out;
  }
  let VARS = new Set();
  // [[expr:d]] in a string → an f-string piece (for live numbers)
  function liveString(s) {
    const esc = String(s).replace(/\{/g, '{{').replace(/\}/g, '}}');
    return esc.replace(/\[\[([^\]]+)\]\]/g, (m, e) => { const i = e.lastIndexOf(':'); const ex = i >= 0 ? e.slice(0, i) : e, d = i >= 0 ? e.slice(i + 1) : '2'; return '{' + pyFn(ex.trim()) + ':.' + (parseInt(d, 10) || 0) + 'f}'; });
  }
  const isLive = s => /\[\[[^\]]+\]\]/.test(String(s));

  function decompose(m) {
    const sx = Math.hypot(m[0], m[1]) || 1e-9, det = m[0] * m[3] - m[1] * m[2];
    return { x: m[4], y: m[5], rot: Math.atan2(m[1], m[0]), sx, sy: det / sx };
  }

  // one object → lines that create it as `v`
  function construct(o, v, scene) {
    const p = Object.assign({}, A.TYPES[o.type].defaults, o.props), L = [];
    const note = s => L.push('# ' + s);
    switch (o.type) {
      case 'text': {
        const fs = n(p.size * 68), c = col(p.color);
        if (isLive(p.text)) { L.push(v + ' = always_redraw(lambda: Tex(rf"' + liveString(p.text) + '", font_size=' + fs + ', color=' + c + '))'); return L; }
        L.push(v + ' = ' + (String(p.text).includes('$') ? 'Tex(' + raw(p.text) : 'Text(' + str(p.text) + (p.font === 'mono' ? ', font="Monospace"' : '')) + ', font_size=' + fs + ', color=' + c + ')');
        break;
      }
      case 'math': {
        const fs = n(p.size * 53), c = col(p.color);
        if (isLive(p.tex)) L.push(v + ' = always_redraw(lambda: MathTex(rf"' + liveString(p.tex) + '", font_size=' + fs + ', color=' + c + '))');
        else L.push(v + ' = MathTex(' + raw(p.tex) + ', font_size=' + fs + ', color=' + c + ')');
        break;
      }
      case 'title':
        L.push(v + ' = VGroup(Text(' + str(p.title) + ', font_size=' + n(p.size * 60) + ', color=' + col(p.color) + ')' + (p.subtitle ? ', Text(' + str(p.subtitle) + ', font_size=' + n(p.size * 30) + ', color=' + col(p.accent) + ')' : '') + ').arrange(DOWN)');
        break;
      case 'shape': {
        const st = ', color=' + col(p.color) + ', stroke_width=' + n(p.sw) + (p.fo > 0 ? ', fill_color=' + col(p.fill) + ', fill_opacity=' + n(p.fo) : '');
        const m = { circle: 'Circle(radius=' + n(p.r) + st + ')', square: 'Square(side_length=' + n(p.r * 2) + st + ')', rect: 'Rectangle(width=' + n(p.w) + ', height=' + n(p.h) + st + ')',
          ellipse: 'Ellipse(width=' + n(p.w) + ', height=' + n(p.h) + st + ')', polygon: 'RegularPolygon(n=' + Math.round(p.n) + st + ').scale(' + n(p.r) + ')', star: 'Star(n=' + Math.round(p.n) + ', outer_radius=' + n(p.r) + st + ')',
          line: 'Line(' + pt(-p.len / 2, 0) + ', ' + pt(p.len / 2, 0) + ', color=' + col(p.color) + ')', arrow: 'Arrow(' + pt(-p.len / 2, 0) + ', ' + pt(p.len / 2, 0) + ', buff=0, color=' + col(p.color) + ')',
          darrow: 'DoubleArrow(' + pt(-p.len / 2, 0) + ', ' + pt(p.len / 2, 0) + ', buff=0, color=' + col(p.color) + ')', dot: 'Dot(color=' + col(p.color) + ')',
          arc: 'Arc(radius=' + n(p.r) + ', angle=' + n(p.sweep * Math.PI / 180) + ', color=' + col(p.color) + ')', brace: 'Brace(Line(' + pt(-p.w / 2, 0) + ', ' + pt(p.w / 2, 0) + '), DOWN, color=' + col(p.color) + ')' };
        L.push(v + ' = ' + (m[p.shape] || 'Circle()'));
        break;
      }
      case 'graph': {
        const step = r => { const raw = r / 8, q = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / q; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * q; };
        L.push(v + '_axes = Axes(x_range=[' + n(p.xmin) + ', ' + n(p.xmax) + ', ' + n(step(p.xmax - p.xmin)) + '], y_range=[' + n(p.ymin) + ', ' + n(p.ymax) + ', ' + n(step((p.ymax - p.ymin) * 1.6)) + '], x_length=' + n(p.w) + ', y_length=' + n(p.h) + ', axis_config={"color": ' + col(p.axis) + ', "include_numbers": ' + (p.nums ? 'True' : 'False') + '})');
        const parts = [v + '_axes'];
        if (p.grid) { L.push(v + '_grid = NumberPlane(x_range=' + '[' + n(p.xmin) + ', ' + n(p.xmax) + '], y_range=[' + n(p.ymin) + ', ' + n(p.ymax) + '], x_length=' + n(p.w) + ', y_length=' + n(p.h) + ', background_line_style={"stroke_opacity": 0.35})'); parts.unshift(v + '_grid'); }
        [[p.f1, p.c1, p.l1, 1], [p.f2, p.c2, p.l2, 2]].forEach(([f, c, l, i]) => {
          if (!f) return;
          L.push(v + '_f' + i + ' = ' + v + '_axes.plot(lambda x: ' + pyFn(f) + ', color=' + col(c) + ', use_smoothing=False)');
          parts.push(v + '_f' + i);
          if (l) { L.push(v + '_l' + i + ' = ' + v + '_axes.get_graph_label(' + v + '_f' + i + ', ' + raw(l) + ')'); parts.push(v + '_l' + i); }
        });
        if (p.area && p.f1) { L.push(v + '_area = ' + v + '_axes.get_area(' + v + '_f1, x_range=[' + n(Math.min(p.a, p.b)) + ', ' + n(Math.max(p.a, p.b)) + '], color=' + col(p.areac) + ', opacity=0.45)'); parts.push(v + '_area'); }
        L.push(v + ' = VGroup(' + parts.join(', ') + ')');
        if (p.tracer && p.f1) L.push('# The travelling dot: ' + v + '_dot = Dot().move_to(' + v + '_axes.i2gp(' + n(p.xmin) + ', ' + v + '_f1)), then MoveAlongPath(' + v + '_dot, ' + v + '_f1)');
        break;
      }
      case 'venn': {
        const k = +p.n === 3 ? 3 : 2, labs = String(p.labels).split(/\s+/);
        const C = k === 2 ? [[-0.8, 0], [0.8, 0]] : [[-0.75, 0.45], [0.75, 0.45], [0, -0.85]];
        note('Venn diagram, shading “' + p.shade + '” (shade regions with Intersection / Union / Difference)');
        L.push(v + ' = VGroup(' + C.slice(0, k).map(([x, y], i) => 'Circle(radius=1.4, color=' + col(p.color) + ').move_to(' + pt(x, y) + ')').join(', ') + ')');
        L.push(v + '.add(*[MathTex(s).next_to(c, UP if c.get_y() >= 0 else DOWN) for s, c in zip(' + JSON.stringify(labs.slice(0, k)) + ', ' + v + '[:' + k + '])])');
        break;
      }
      case 'vector': {
        const parts = [];
        (p.paths || []).forEach((path, i) => {
          const nd = path.nodes || []; if (nd.length < 2) return;
          const w = v + '_p' + i; parts.push(w);
          L.push(w + ' = VMobject(stroke_color=' + col(path.stroke) + ', stroke_width=' + n(path.sw || 0) + (path.closed && path.fill ? ', fill_color=' + col(path.fill) + ', fill_opacity=' + n(path.fo == null ? 1 : path.fo) : '') + ')');
          L.push(w + '.start_new_path(np.array(' + pt(nd[0].x, -nd[0].y) + '))');
          const seg = (a, b) => L.push(w + '.add_cubic_bezier_curve_to(np.array(' + pt(a.x + (a.ox || 0), -(a.y + (a.oy || 0))) + '), np.array(' + pt(b.x + (b.ix || 0), -(b.y + (b.iy || 0))) + '), np.array(' + pt(b.x, -b.y) + '))');
          for (let j = 0; j < nd.length - 1; j++) seg(nd[j], nd[j + 1]);
          if (path.closed) seg(nd[nd.length - 1], nd[0]);
        });
        L.push(v + ' = ' + (parts.length === 1 ? parts[0] : 'VGroup(' + parts.join(', ') + ')'));
        break;
      }
      case 'curve': {
        const S = n(p.size), k = Math.max(1, Math.round(p.k));
        const F = { lissajous: ['np.sin(' + n(p.a) + '*t + PI/2)', 'np.sin(' + n(p.b) + '*t)', 'TAU'], rose: ['np.cos(' + k + '*t)*np.cos(t)', 'np.cos(' + k + '*t)*np.sin(t)', k % 2 ? 'PI' : 'TAU'],
          spiral: ['t/' + n(2 * Math.PI * p.turns) + '*np.cos(t)', 't/' + n(2 * Math.PI * p.turns) + '*np.sin(t)', n(2 * Math.PI * p.turns)], cardioid: ['(2*np.cos(t) - np.cos(2*t))/3', '(2*np.sin(t) - np.sin(2*t))/3', 'TAU'],
          heart: ['16*np.sin(t)**3/17', '(13*np.cos(t) - 5*np.cos(2*t) - 2*np.cos(3*t) - np.cos(4*t))/17', 'TAU'], astroid: ['np.cos(t)**3', 'np.sin(t)**3', 'TAU'],
          epicycloid: ['(' + (k + 1) + '*np.cos(t) - np.cos(' + (k + 1) + '*t))/' + (k + 2), '(' + (k + 1) + '*np.sin(t) - np.sin(' + (k + 1) + '*t))/' + (k + 2), 'TAU'],
          lemniscate: ['np.cos(t)/(1 + np.sin(t)**2)', 'np.sin(t)*np.cos(t)/(1 + np.sin(t)**2)', 'TAU'], spiro: ['(3*np.cos(t) + 4*np.cos(3*t/5))/7', '(3*np.sin(t) - 4*np.sin(3*t/5))/7', '10*PI'],
          butterfly: ['np.sin(t)*(np.exp(np.cos(t)) - 2*np.cos(4*t) - np.sin(t/12)**5)/4.2', 'np.cos(t)*(np.exp(np.cos(t)) - 2*np.cos(4*t) - np.sin(t/12)**5)/4.2', '12*PI'] }[p.shape];
        if (F) L.push(v + ' = ParametricFunction(lambda t: ' + S + '*np.array([' + F[0] + ', ' + F[1] + ', 0]), t_range=[0, ' + F[2] + '], color=' + col(p.color) + ')');
        else L.push(v + ' = ParametricFunction(lambda t: np.array([' + pyFn(p.xt, 't') + ', ' + pyFn(p.yt, 't') + ', 0]), t_range=[' + n(p.t0) + ', ' + n(p.t1) + '], color=' + col(p.color) + ')  # rescale to taste');
        break;
      }
      case 'textpath':
        note('Text on a curve has no single Manim class; this is straight text');
        L.push(v + ' = Text(' + str(p.text) + ', font_size=' + n(p.size * 68) + ', color=' + col(p.color) + ')');
        break;
      case 'image':
        note('Export the image next to this file and put its name here');
        L.push(v + ' = ImageMobject("' + (o.name || 'image').replace(/[^\w.-]+/g, '_') + '.png").set(width=' + n(p.w) + ')');
        break;
      case 'group': break;
      default: {
        const b = A.build(o).bb;
        note(A.TYPES[o.type].label + ' “' + o.name + '” has no direct Manim equivalent: a placeholder box of the same size');
        L.push(v + ' = Rectangle(width=' + n(b[2] - b[0]) + ', height=' + n(b[3] - b[1]) + ', color=GREY, stroke_opacity=0.6)');
      }
    }
    return L;
  }

  function generate(scene) {
    VARS = new Set((scene.vars || []).map(d => d.name).filter(Boolean));
    const objs = scene.objects, byId = Object.fromEntries(objs.map(o => [o.id, o]));
    const used = new Set(['self', 'np', 'config']);
    const names = new Map();
    for (const o of objs) {
      let b = String(o.name || o.type).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || o.type;
      if (/^\d/.test(b)) b = 'm_' + b;
      if (VARS.has(b) || ['in', 'is', 'or', 'and', 'not', 'def', 'class', 'from', 'import', 'lambda', 'return', 'for', 'if', 'else', 'pass'].includes(b)) b += '_';
      let v = b, k = 2; while (used.has(v)) v = b + '_' + k++;
      used.add(v); names.set(o.id, v);
    }
    const V = o => names.get(o.id);
    const cam = scene.camera && (Object.keys(scene.camera.keys || {}).length || scene.camera.zoom !== 1 || scene.camera.x || scene.camera.y || scene.camera.rotation);
    const cls = (String(scene.name || 'Animation').replace(/[^A-Za-z0-9]+(.)?/g, (m, c) => c ? c.toUpperCase() : '').replace(/^[^A-Za-z]+/, '') || 'Animation');
    const [aw, ah] = String(scene.aspect || '16:9').split(':').map(Number);
    const out = [];
    out.push('from manim import *', 'import numpy as np', '',
      '# Made with Animath. Render it with:  manim -pqh ' + cls.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() + '.py ' + cls,
      '# Timings are rebuilt step by step; where Animath overlaps animations that start at different times,',
      '# they play one after another here (marked “overlaps”).', '',
      'config.background_color = ' + JSON.stringify(A.color(scene.bg || '#000000')),
      'config.frame_height = 8', 'config.frame_width = ' + n(8 * aw / ah),
      'config.pixel_height = 1080', 'config.pixel_width = ' + (Math.round(1080 * aw / ah / 2) * 2), '', '',
      'class ' + cls + '(' + (cam ? 'MovingCameraScene' : 'Scene') + '):', '    def construct(self):');
    const body = [];
    const P = s => body.push(s);
    if (VARS.size) {
      P('# Live values (ValueTracker)');
      for (const d of scene.vars) if (d.name) P(d.name + ' = ValueTracker(' + n(d.keys && d.keys.length ? d.keys[0].v : d.v) + ')');
      P('');
    }
    const later = [];
    // build objects (groups after their members)
    const order = [], seen = new Set();
    const visit = o => { if (seen.has(o.id)) return; seen.add(o.id); if (o.type === 'group') objs.filter(c => c.parent === o.id).forEach(visit); order.push(o); };
    objs.forEach(visit);
    for (const o of order) {
      const v = V(o);
      if (o.type === 'group') { P(v + ' = Group(' + objs.filter(c => c.parent === o.id).map(V).join(', ') + ')  # group'); continue; }
      construct(o, v, scene).forEach(P);
      const t0 = o.start + A.phases(o).inD + 0.001;
      const d = decompose(A.restWorld(scene, o, t0));
      const live = String(JSON.stringify(o.props)).includes('[[');
      const tf = [];
      if (Math.abs(d.sx - 1) > 1e-3 || Math.abs(d.sy - d.sx) > 1e-3) tf.push(Math.abs(d.sy - d.sx) < 1e-3 ? '.scale(' + n(d.sx) + ')' : '.stretch(' + n(d.sx) + ', 0).stretch(' + n(Math.abs(d.sy)) + ', 1)');
      if (d.sy < 0) tf.push('.flip(RIGHT)');
      if (Math.abs(d.rot) > 1e-3) tf.push('.rotate(' + n(d.rot) + ')');
      tf.push('.move_to(' + pt(d.x, d.y) + ')');
      const op = A.keyVal(o, 'opacity', t0);
      if (op < 0.999) tf.push('.set_opacity(' + n(op) + ')');
      if (o.style && o.style.dash && o.style.dash !== 'none') P('# dashed: use DashedVMobject(' + v + ')');
      if (o.style && o.style.grad) P(v + '.set_color_by_gradient(' + col((o.props || {}).color) + ', ' + col(o.style.grad) + ')');
      if (live) P('# live: rebuilt every frame, so the position is applied inside always_redraw');
      P(v + tf.join(''));
      if (o.parent && byId[o.parent] && byId[o.parent].type !== 'group') P('# rig: ' + v + ' is attached to ' + V(byId[o.parent]) + ' in Animath (add an updater to follow it)');
      if (o.attach && byId[o.attach.to] && byId[o.attach.to].type === 'graph') {
        const G = byId[o.attach.to], g = V(G), gp = Object.assign({}, A.TYPES.graph.defaults, G.props), fn = g + '_f' + (o.attach.fn === 2 ? 2 : 1);
        let xs;
        if (!String(o.attach.x || '').trim()) { P(v + '_x = ValueTracker(' + n(gp.xmin) + ')'); xs = v + '_x.get_value()'; later.push([o.start, o.end - o.start, v + '_x.animate.set_value(' + n(gp.xmax) + ')']); }
        else xs = pyFn(o.attach.x);
        P(v + '.add_updater(lambda m: m.move_to(' + g + '_axes.i2gp(' + xs + ', ' + fn + ')' + (o.x || o.y ? ' + np.array(' + pt(o.x || 0, o.y || 0) + ')' : '') + '))  # rides along the graph');
      }
      if (o.loop === 'spin') P(v + '.add_updater(lambda m, dt: m.rotate(-0.9 * dt))  # loop: spin');
      else if (o.loop && o.loop !== 'none') P('# loop “' + o.loop + '” isn’t exported (an updater could add it)');
      if (o.hidden) P('# ' + v + ' is a hidden guide in Animath');
    }
    P('');
    // timeline events
    const ev = [];
    // code: one animation expression (any trailing '  # note' becomes a separate comment)
    const E = (t, dur, code, kind, m) => { const i = code.indexOf('  # '); ev.push({ t: Math.max(0, t), dur: Math.max(0, dur), code: i >= 0 ? code.slice(0, i) : code, note: i >= 0 ? code.slice(i + 4) : '', kind: kind || 'play', m }); };
    later.forEach(a => E(...a));
    const morphTargets = new Set(objs.filter(A.isMorph).map(o => o.anOut.target));
    for (const o of objs) {
      if (o.hidden && o.type !== 'group') continue;
      const v = V(o), { inD, outD } = A.phases(o), r = rateArg(o.anIn.rate);
      if (!morphTargets.has(o.id) && !(o.parent && byId[o.parent] && byId[o.parent].type === 'group')) {
        const IN = { create: 'Create(' + v + r + ')', write: 'Write(' + v + r + ')', drawfill: 'DrawBorderThenFill(' + v + r + ')', grow: 'GrowFromCenter(' + v + r + ')', spin: 'SpinInFromNothing(' + v + r + ')',
          fadein: 'FadeIn(' + v + r + ')', fadeup: 'FadeIn(' + v + ', shift=UP*0.6' + r + ')', slideL: 'FadeIn(' + v + ', shift=RIGHT*3' + r + ')', slideR: 'FadeIn(' + v + ', shift=LEFT*3' + r + ')', dropin: 'FadeIn(' + v + ', shift=DOWN*2.5' + r + ')',
          zoomin: 'FadeIn(' + v + ', scale=0.25' + r + ')', zoomout: 'FadeIn(' + v + ', scale=2.8' + r + ')', pop: 'GrowFromCenter(' + v + ', rate_func=rate_functions.ease_out_back)', spring: 'GrowFromCenter(' + v + ', rate_func=rate_functions.ease_out_elastic)',
          bounce: 'FadeIn(' + v + ', shift=DOWN*3, rate_func=rate_functions.ease_out_bounce)', fallin: 'FadeIn(' + v + ', shift=DOWN*4.5, rate_func=rate_functions.ease_out_bounce)', typewriter: (o.type === 'text' ? 'AddTextLetterByLetter(' : 'Write(') + v + ')' }[o.anIn.type];
        if (o.anIn.type === 'appear' || !inD) E(o.start, 0, v, 'add', v);
        else E(o.start, inD, IN || 'FadeIn(' + v + ')  # ' + o.anIn.type);
        if (o.path && byId[o.path.to]) E(o.start, o.end - o.start, 'MoveAlongPath(' + v + ', ' + V(byId[o.path.to]) + (byId[o.path.to].type === 'vector' && ((byId[o.path.to].props.paths || []).filter(q => (q.nodes || []).length > 1).length > 1) ? '[0]' : '') + (o.path.ease === 'linear' ? ', rate_func=linear' : '') + ')');
      }
      for (const em of o.emph || []) {
        const X = { indicate: 'Indicate(' + v + ')', circumscribe: 'Circumscribe(' + v + ')', flash: 'Flash(' + v + ')', underline: 'ShowPassingFlash(Underline(' + v + '))', wiggle: 'Wiggle(' + v + ')', spin: 'Rotate(' + v + ', angle=TAU)',
          pulse: 'Indicate(' + v + ', scale_factor=1.12, color=' + v + '.get_color())', heartbeat: 'Indicate(' + v + ', scale_factor=1.16, color=' + v + '.get_color())', glow: 'Indicate(' + v + ', scale_factor=1)', boing: 'Wiggle(' + v + ')' }[em.type];
        E(em.t, em.dur, (X || 'Wiggle(' + v + ')  # ' + em.type) + (em.dur !== 1 ? '' : ''));
      }
      // keyframes → .animate
      const kt = [...new Set(Object.values(o.keys || {}).flat().map(q => q.t))].sort((a, b) => a - b);
      for (let i = 1; i < kt.length; i++) {
        const a = kt[i - 1], b = kt[i];
        const wa = decompose(A.restWorld(scene, o, a)), wb = decompose(A.restWorld(scene, o, b));
        let c = v + '.animate';
        if (Math.abs(wb.sx / wa.sx - 1) > 1e-3) c += '.scale(' + n(wb.sx / wa.sx) + ')';
        if (Math.abs(wb.rot - wa.rot) > 1e-3) c += '.rotate(' + n(wb.rot - wa.rot) + ')';
        if (Math.hypot(wb.x - wa.x, wb.y - wa.y) > 1e-3) c += '.move_to(' + pt(wb.x, wb.y) + ')';
        const oa = A.keyVal(o, 'opacity', a), ob = A.keyVal(o, 'opacity', b);
        if (Math.abs(ob - oa) > 1e-3) c += '.set_opacity(' + n(ob) + ')';
        if (c !== v + '.animate') E(a, b - a, c);
      }
      // out
      if (A.isMorph(o) && byId[o.anOut.target]) {
        const tg = V(byId[o.anOut.target]);
        const fn = o.anOut.type === 'transformMatch' ? (o.type === 'math' && byId[o.anOut.target].type === 'math' ? 'TransformMatchingTex' : 'TransformMatchingShapes') : 'ReplacementTransform';
        E(o.end - outD, outD, fn + '(' + v + ', ' + tg + rateArg(o.anOut.rate) + ')');
      } else if (o.anOut.type !== 'none' && outD) {
        const r2 = rateArg(o.anOut.rate);
        const OUT = { fadeout: 'FadeOut(' + v + r2 + ')', fadedown: 'FadeOut(' + v + ', shift=DOWN*0.6' + r2 + ')', uncreate: 'Uncreate(' + v + r2 + ')', shrink: 'ShrinkToCenter(' + v + r2 + ')', slideL: 'FadeOut(' + v + ', shift=LEFT*3' + r2 + ')', slideR: 'FadeOut(' + v + ', shift=RIGHT*3' + r2 + ')',
          riseaway: 'FadeOut(' + v + ', shift=UP*2.5' + r2 + ')', zoomin: 'FadeOut(' + v + ', scale=2.8' + r2 + ')', popout: 'ShrinkToCenter(' + v + ', rate_func=rate_functions.ease_in_back)', fall: 'FadeOut(' + v + ', shift=DOWN*5, rate_func=rate_functions.ease_in_quad)', spinout: 'ShrinkToCenter(' + v + r2 + ')', typewriter: 'Unwrite(' + v + ')' }[o.anOut.type];
        if (!(o.parent && byId[o.parent] && byId[o.parent].type === 'group')) E(o.end - outD, outD, OUT || 'FadeOut(' + v + ')  # ' + o.anOut.type);
      } else if (o.end < scene.duration - 1e-3 && !(o.parent && byId[o.parent] && byId[o.parent].type === 'group')) E(o.end, 0, v, 'remove', v);
    }
    for (const d of scene.vars || []) {
      const k = d.keys || [];
      for (let i = 1; i < k.length; i++) E(k[i - 1].t, k[i].t - k[i - 1].t, d.name + '.animate.set_value(' + n(k[i].v) + ')' + (k[i].ease === 'linear' ? '' : ''), 'play');
    }
    if (cam) {
      const ck = [...new Set(Object.values(scene.camera.keys || {}).flat().map(q => q.t))].sort((a, b) => a - b);
      const cs = t => A.camState(scene.camera, t);
      const c0 = cs(0);
      if (c0.zoom !== 1 || c0.x || c0.y) P('self.camera.frame.move_to(' + pt(c0.x, c0.y) + ').scale(' + n(1 / c0.zoom) + ')');
      for (let i = 1; i < ck.length; i++) { const a = cs(ck[i - 1]), b = cs(ck[i]); E(ck[i - 1], ck[i] - ck[i - 1], 'self.camera.frame.animate.move_to(' + pt(b.x, b.y) + ').scale(' + n(a.zoom / b.zoom) + ')' + (Math.abs(b.rotation - a.rotation) > 1e-3 ? '.rotate(' + n(a.rotation - b.rotation) + ')' : '')); }
    }
    // schedule: animations that overlap in time play together, each delayed with Succession(Wait(…), …)
    ev.sort((a, b) => a.t - b.t || (a.kind === 'play' ? 1 : -1));
    const withRT = (code, d) => code.includes('.animate.') ? code.replace('.animate.', '.animate(run_time=' + n(Math.max(d, 1 / 30)) + ').') : code.replace(/\)\s*$/, ', run_time=' + n(Math.max(d, 1 / 30)) + ')');
    const asAnim = e => e.kind === 'add' ? 'FadeIn(' + e.m + ', run_time=0.04)' : e.kind === 'remove' ? 'FadeOut(' + e.m + ', run_time=0.04)' : withRT(e.code, e.dur);
    const clusters = [];
    for (const e of ev) {
      const c = clusters[clusters.length - 1], end = e.t + Math.max(e.dur, e.kind === 'play' ? 0.01 : 0);
      if (c && e.t < c.end - 1e-3) { c.items.push(e); c.end = Math.max(c.end, end); }
      else clusters.push({ start: e.t, end, items: [e] });
    }
    let cursor = 0;
    for (const c of clusters) {
      if (c.start - cursor > 0.01) P('self.wait(' + n(c.start - cursor) + ')');
      c.items.filter(e => e.note).forEach(e => P('# ' + e.note));
      const sameStart = c.items.every(e => Math.abs(e.t - c.start) < 0.02);
      if (sameStart) {
        c.items.filter(e => e.kind === 'add').forEach(e => P('self.add(' + e.m + ')'));
        const plays = c.items.filter(e => e.kind === 'play');
        if (plays.length) {
          const rt = Math.max(...plays.map(e => e.dur), 1 / 30);
          P('self.play(' + plays.map(e => Math.abs(e.dur - rt) > 1e-3 ? withRT(e.code, e.dur) : e.code).join(', ') + ', run_time=' + n(rt) + ')');
        }
        c.items.filter(e => e.kind === 'remove').forEach(e => P('self.remove(' + e.m + ')'));
        cursor = Math.max(c.start + (plays.length ? Math.max(...plays.map(e => e.dur)) : 0), c.start);
        continue;
      }
      P('self.play(');
      c.items.forEach((e, i) => { const off = e.t - c.start, a = asAnim(e); P('    ' + (off > 1e-3 ? 'Succession(Wait(run_time=' + n(off) + '), ' + a + ')' : a) + (i < c.items.length - 1 ? ',' : '')); });
      P(')');
      cursor = c.end;
    }
    if (scene.duration - cursor > 0.01) P('self.wait(' + n(scene.duration - cursor) + ')');
    if (!body.some(l => l.startsWith('self.'))) P('self.wait(1)');
    return out.concat(body.map(l => l ? '        ' + l : '')).join('\n') + '\n';
  }
  return { generate };
})();
