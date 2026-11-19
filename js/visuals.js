/*
 * BeatVision · 视觉引擎
 * 背景：WebGL 着色器（离屏渲染）→ 贴到 2D 画布；
 * 前景：旋转唱片、环形频谱、底部频谱柱、波形、节拍粒子、曲名、进度条。
 * 最终画面全部落在同一张 2D 画布上，录制时直接采集这张画布。
 */
(function (global) {
  'use strict';

  const SH = global.BeatShaders;
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

  const UNIFORMS = ['uRes', 'uShake', 'uTime', 'uFlow', 'uBass', 'uMid', 'uHigh', 'uBeat', 'uLevel', 'uHue', 'uPunch', 'uA', 'uB', 'uC'];
  const FONT = '"Orbitron", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';
  const LUT_N = 128;
  const MAX_PARTICLES = 500;

  const PALETTES = [
    { id: 'neon', name: '霓虹', colors: ['#00e5ff', '#ff2bd6', '#7a3cff'] },
    { id: 'sunset', name: '落日', colors: ['#ff5e3a', '#ff2a7a', '#ffc23a'] },
    { id: 'acid', name: '酸性', colors: ['#b6ff00', '#00ffa3', '#00b3ff'] },
    { id: 'ice', name: '冰蓝', colors: ['#7df9ff', '#3a7bff', '#d8f3ff'] },
    { id: 'fire', name: '烈焰', colors: ['#ff3b1f', '#ff9a00', '#ffe14d'] },
    { id: 'candy', name: '糖果', colors: ['#ff6ad5', '#8c6bff', '#6ad5ff'] },
    { id: 'gold', name: '黑金', colors: ['#ffd27a', '#ff8a3c', '#fff3d6'] }
  ];

  class Visualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.glCanvas = document.createElement('canvas');
      this.gl = null;
      this.glLost = false;
      this.programs = {};
      this._initGL();

      this.W = canvas.width;
      this.H = canvas.height;
      this.scale = 0.75;
      this._emaDt = 16;
      this._cool = 3;

      this.time = 0;
      this.flow = 0;
      this.angle = 0;
      this.hueM = 0;
      this.scene = 'tunnel';
      this.cutFlash = 0;
      this.shake = [0, 0];

      this.particles = [];
      this.rings = [];
      this._amb = 0;
      this.peaks = new Float32Array(64);

      this.cover = null;
      this._coverVer = 0;
      this._discKey = '';
      this._disc = document.createElement('canvas');
      this._sheen = document.createElement('canvas');

      this.lut = new Array(LUT_N);
      this.setPalette('neon');
    }

    /* ---------------- WebGL ---------------- */
    _initGL() {
      const c = this.glCanvas;
      const opts = { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' };
      let gl = null;
      try { gl = c.getContext('webgl', opts) || c.getContext('experimental-webgl', opts); } catch (e) { gl = null; }
      this.gl = gl;
      if (!gl) {
        console.warn('[BeatVision] 当前环境没有 WebGL，背景改用简化渲染');
        return;
      }
      c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.glLost = true; });
      c.addEventListener('webglcontextrestored', () => { this.glLost = false; this.programs = {}; this._setupBuffer(); });
      this._setupBuffer();
    }

    _setupBuffer() {
      const gl = this.gl;
      this._buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    }

    _compile(fragSrc) {
      const gl = this.gl;
      const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          const info = gl.getShaderInfoLog(s) || 'unknown';
          gl.deleteShader(s);
          throw new Error(info);
        }
        return s;
      };
      const vs = mk(gl.VERTEX_SHADER, SH.VERT);
      const fs = mk(gl.FRAGMENT_SHADER, fragSrc);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
      const u = {};
      UNIFORMS.forEach((n) => { u[n] = gl.getUniformLocation(p, n); });
      return { p, u };
    }

    _program(id) {
      if (id in this.programs) return this.programs[id];
      let out = null;
      const src = SH.SCENES[id];
      if (src && this.gl && !this.glLost) {
        try {
          out = this._compile(SH.HEAD + src + SH.TAIL);
        } catch (e) {
          console.error('[BeatVision] 场景着色器编译失败: ' + id + ' → ' + e.message);
        }
      }
      this.programs[id] = out;
      return out;
    }

    // 启动后在空闲时把所有场景编译好，避免录制中切换场景时卡一下
    precompile() {
      const ids = Object.keys(SH.SCENES);
      let i = 0;
      const step = () => {
        if (i >= ids.length) return;
        this._program(ids[i++]);
        setTimeout(step, 120);
      };
      setTimeout(step, 300);
    }

    programStatus() {
      const out = {};
      Object.keys(SH.SCENES).forEach((id) => { out[id] = id in this.programs ? !!this.programs[id] : 'pending'; });
      return out;
    }

    /* ---------------- 设置 ---------------- */
    setSize(w, h) {
      this.W = this.canvas.width = w;
      this.H = this.canvas.height = h;
      this.scale = Math.min(1, Math.sqrt(1.1e6 / (w * h)));
      this._emaDt = 16;
      this._cool = 3;
      this._applyGLSize();
      this._discKey = '';
      this.particles.length = 0;
      this.rings.length = 0;
    }

    _applyGLSize() {
      this.glCanvas.width = Math.max(2, Math.round(this.W * this.scale));
      this.glCanvas.height = Math.max(2, Math.round(this.H * this.scale));
    }

    setScene(id, flash) {
      if (!SH.SCENES[id]) return;
      if (id !== this.scene && flash !== false) this.cutFlash = 1;
      this.scene = id;
    }

    setPalette(id) {
      const p = PALETTES.find((x) => x.id === id) || PALETTES[0];
      this.palette = p;
      this.rgb = p.colors.map(hex);
      for (let i = 0; i < LUT_N; i++) {
        const t = (i / LUT_N) * 3, k0 = Math.floor(t), f = t - k0, k = f * f * (3 - 2 * f);
        const a = this.rgb[k0 % 3], b = this.rgb[(k0 + 1) % 3];
        const ch = (j) => Math.round((a[j] + (b[j] - a[j]) * k) * 255);
        this.lut[i] = 'rgb(' + ch(0) + ',' + ch(1) + ',' + ch(2) + ')';
      }
      this._discKey = '';
    }

    setCover(img) {
      this.cover = img || null;
      this._coverVer++;
      this._discKey = '';
    }

    color(t) {
      t = t - Math.floor(t);
      return this.lut[(t * LUT_N) | 0];
    }

    _layout(W, H) {
      const m = Math.min(W, H), s = m / 1080;
      if (H > W * 1.2) {
        // 竖屏：所有重要内容都避开 TikTok 顶部 / 底部 / 右侧的界面遮挡
        return {
          s, cx: W / 2, cy: H * 0.4, R: m * 0.21, textW: W * 0.72,
          titleY: H * 0.665, artistY: H * 0.702,
          barsX0: W * 0.14, barsX1: W * 0.86, barsBase: H * 0.815, barsH: H * 0.085, progY: H * 0.826
        };
      }
      const wide = W > H * 1.2;
      return {
        s, cx: W / 2, cy: H * 0.42, R: m * 0.165, textW: W * (wide ? 0.6 : 0.8),
        titleY: H * 0.795, artistY: H * 0.838,
        barsX0: W * (wide ? 0.2 : 0.1), barsX1: W * (wide ? 0.8 : 0.9), barsBase: H * 0.955, barsH: H * 0.085, progY: H * 0.972
      };
    }

    /* ---------------- 每帧渲染 ---------------- */
    render(dt, a, S, st) {
      const ctx = this.ctx, W = this.W, H = this.H;
      const react = S.react;
      const bass = clamp(a.bass * react, 0, 1.4);
      const mid = clamp(a.mid * react, 0, 1.4);
      const high = clamp(a.high * react, 0, 1.4);
      const level = clamp(a.level * (0.6 + 0.4 * react), 0, 1.3);
      const beat = a.beat;

      // 画质自适应：持续掉帧时降低背景渲染分辨率（前景元素始终按输出分辨率绘制）
      const ms = dt * 1000;
      if (ms < 99) this._emaDt += (ms - this._emaDt) * 0.05;
      this._cool -= dt;
      if (this._emaDt > 26 && this._cool <= 0 && this.scale > 0.4) {
        this.scale = Math.max(0.4, this.scale - 0.12);
        this._applyGLSize();
        this._cool = 2;
        this._emaDt = 18;
      }

      this.time += dt;
      this.flow += dt * S.speed * (0.35 + level + beat * 0.5 * react);
      this.angle += dt * S.speed * (0.5 + level * 2.4);
      this.hueM += ((a.centroid - 0.5) * 0.7 * S.melody - this.hueM) * (1 - Math.exp(-dt * 4));
      const hue = this.time * 0.012 + this.hueM;

      if (a.beatHit) {
        const ang = Math.random() * TAU, mag = 0.014 * S.punch * (0.5 + bass);
        this.shake[0] = Math.cos(ang) * mag;
        this.shake[1] = Math.sin(ang) * mag;
      }
      const shx = this.shake[0] * beat, shy = this.shake[1] * beat;
      this.cutFlash *= Math.exp(-dt * 9);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      const ok = this._drawGL({ bass, mid, high, level, beat, hue, shx, shy, punch: S.punch });
      if (!ok) this._drawFallback(ctx, W, H, hue, bass, beat);

      const L = this._layout(W, H);
      const k = 1 + beat * 0.06 * S.punch + bass * 0.025;

      if (S.showText || S.showBars || S.showProgress) {
        const y0 = L.titleY - 130 * L.s;
        const g = ctx.createLinearGradient(0, y0, 0, H);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.45, 'rgba(0,0,0,0.42)');
        g.addColorStop(1, 'rgba(0,0,0,0.6)');
        ctx.fillStyle = g;
        ctx.fillRect(0, y0, W, H - y0);
      }

      // —— 中心组：跟着镜头冲击一起抖动 ——
      ctx.save();
      ctx.translate(shx * Math.min(W, H) * 0.5, -shy * Math.min(W, H) * 0.5);
      if (S.showWave) this._drawWave(ctx, a, L, S, hue, W);
      if (S.showParticles) this._drawParticles(ctx, dt, a, L, S, hue, bass, level, k, W, H);
      else { this.particles.length = 0; this.rings.length = 0; }
      if (S.showRing) this._drawRing(ctx, a, L, S, hue, k);
      if (S.showDisc) this._drawDisc(ctx, L, hue, k, beat);
      ctx.restore();

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      if (S.showBars) this._drawBars(ctx, dt, a, L, S, hue);
      if (S.showText) this._drawText(ctx, L, S, hue);
      if (S.showProgress) this._drawProgress(ctx, L, hue, st.progress);

      // —— 节拍闪光 / 切场景闪白 / 片尾淡出 ——
      ctx.globalCompositeOperation = 'source-over';
      const fl = Math.min(0.32, S.flash * beat * beat * 0.4) + this.cutFlash * 0.45;
      if (fl > 0.004) {
        ctx.globalAlpha = Math.min(0.7, fl);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, H);
      }
      if (st.fade < 0.999) {
        ctx.globalAlpha = 1 - clamp(st.fade);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
      }
      ctx.globalAlpha = 1;
    }

    _drawGL(v) {
      const gl = this.gl;
      if (!gl || this.glLost || gl.isContextLost()) return false;
      const prog = this._program(this.scene);
      if (!prog) return false;
      const c = this.glCanvas, u = prog.u, rgb = this.rgb;
      gl.viewport(0, 0, c.width, c.height);
      gl.useProgram(prog.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(u.uRes, c.width, c.height);
      gl.uniform2f(u.uShake, v.shx, v.shy);
      gl.uniform1f(u.uTime, this.time);
      gl.uniform1f(u.uFlow, this.flow);
      gl.uniform1f(u.uBass, v.bass);
      gl.uniform1f(u.uMid, v.mid);
      gl.uniform1f(u.uHigh, v.high);
      gl.uniform1f(u.uBeat, v.beat);
      gl.uniform1f(u.uLevel, v.level);
      gl.uniform1f(u.uHue, v.hue);
      gl.uniform1f(u.uPunch, v.punch);
      gl.uniform3f(u.uA, rgb[0][0], rgb[0][1], rgb[0][2]);
      gl.uniform3f(u.uB, rgb[1][0], rgb[1][1], rgb[1][2]);
      gl.uniform3f(u.uC, rgb[2][0], rgb[2][1], rgb[2][2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.drawImage(c, 0, 0, this.W, this.H);
      return true;
    }

    _drawFallback(ctx, W, H, hue, bass, beat) {
      ctx.fillStyle = '#05050a';
      ctx.fillRect(0, 0, W, H);
      const r = Math.max(W, H) * (0.5 + 0.15 * bass);
      const g = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, r);
      g.addColorStop(0, this.color(hue));
      g.addColorStop(0.5, this.color(hue + 0.33));
      g.addColorStop(1, '#05050a');
      ctx.globalAlpha = 0.3 + 0.35 * beat;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    /* ---------------- 前景元素 ---------------- */
    _drawWave(ctx, a, L, S, hue, W) {
      const w = a.wave, n = w.length, amp = L.R * 0.6 * Math.min(1.6, S.react);
      ctx.beginPath();
      for (let i = 0; i < n; i += 2) {
        const u = i / (n - 2);
        const x = u * W, y = L.cy + w[i] * amp * Math.sqrt(Math.sin(Math.PI * u));
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = this.color(hue + 0.5);
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = 12 * L.s;
      ctx.stroke();
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3 * L.s;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    _drawParticles(ctx, dt, a, L, S, hue, bass, level, k, W, H) {
      const ps = this.particles, rings = this.rings, s = L.s;
      if (a.beatHit) {
        const n = Math.round((10 + 22 * bass) * Math.min(1.5, S.react));
        const r0 = L.R * 1.15 * k;
        for (let i = 0; i < n && ps.length < MAX_PARTICLES; i++) {
          const ang = Math.random() * TAU, sp = (160 + Math.random() * 520) * s * (0.6 + bass * 0.8);
          const life = 0.6 + Math.random() * 0.9;
          ps.push({
            x: L.cx + Math.cos(ang) * r0, y: L.cy + Math.sin(ang) * r0,
            vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
            life, max: life, size: (1.5 + Math.random() * 3.5) * s, c: hue + Math.random() * 0.4, drag: 1.6
          });
        }
        if (rings.length < 6) rings.push({ r: r0, a: 1 });
      }
      this._amb += dt * (6 + 40 * level);
      while (this._amb >= 1) {
        this._amb -= 1;
        if (ps.length >= MAX_PARTICLES) continue;
        const life = 2 + Math.random() * 3;
        ps.push({
          x: Math.random() * W, y: H + 10 * s,
          vx: (Math.random() - 0.5) * 40 * s, vy: -(60 + Math.random() * 200) * s * (0.5 + level),
          life, max: life, size: (1 + Math.random() * 2.5) * s, c: hue + Math.random() * 0.5, drag: 0
        });
      }

      ctx.globalCompositeOperation = 'lighter';
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.r += dt * L.R * 2.4;
        r.a -= dt * 2.2;
        if (r.a <= 0) { rings.splice(i, 1); continue; }
        ctx.globalAlpha = r.a * 0.6;
        ctx.strokeStyle = this.color(hue + 0.2);
        ctx.lineWidth = (1 + 5 * r.a) * s;
        ctx.beginPath();
        ctx.arc(L.cx, L.cy, r.r, 0, TAU);
        ctx.stroke();
      }
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.life -= dt;
        if (p.life <= 0) { ps[i] = ps[ps.length - 1]; ps.pop(); continue; }
        if (p.drag) { const d = Math.exp(-dt * p.drag); p.vx *= d; p.vy *= d; }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.globalAlpha = Math.min(1, (p.life / p.max) * 1.5) * 0.9;
        ctx.fillStyle = this.color(p.c);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    _drawRing(ctx, a, L, S, hue, k) {
      const n = 56, bars = a.bars, r0 = L.R * 1.13 * k, maxLen = L.R * 0.72;
      const lw = Math.max(2, ((Math.PI * r0) / n) * 0.55);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.lineWidth = pass ? lw : lw * 2.6;
        ctx.globalAlpha = pass ? 0.95 : 0.16;
        for (let i = 0; i < n; i++) {
          const v = clamp(bars[i] * S.react);
          const len = 4 * L.s + v * maxLen;
          const ang = ((i + 0.5) / n) * Math.PI;
          const sx = Math.sin(ang), cy = -Math.cos(ang);
          ctx.strokeStyle = this.color(hue + (i / n) * 0.5);
          ctx.beginPath();
          ctx.moveTo(L.cx + sx * r0, L.cy + cy * r0);
          ctx.lineTo(L.cx + sx * (r0 + len), L.cy + cy * (r0 + len));
          ctx.moveTo(L.cx - sx * r0, L.cy + cy * r0);
          ctx.lineTo(L.cx - sx * (r0 + len), L.cy + cy * (r0 + len));
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    _buildDisc(R, s) {
      const D = Math.ceil(R * 2) + 8, o = D / 2;
      const c = this._disc;
      c.width = c.height = D;
      const x = c.getContext('2d');
      const circle = (r) => { x.beginPath(); x.arc(o, o, r, 0, TAU); };

      let g = x.createRadialGradient(o, o, R * 0.1, o, o, R);
      g.addColorStop(0, '#1b1b24');
      g.addColorStop(1, '#050508');
      x.fillStyle = g;
      circle(R); x.fill();

      x.strokeStyle = 'rgba(255,255,255,0.06)';
      x.lineWidth = Math.max(1, s);
      for (let r = R * 0.46; r < R * 0.97; r += R * 0.03) { circle(r); x.stroke(); }

      const lr = this.cover ? R * 0.64 : R * 0.4;
      x.save();
      circle(lr); x.clip();
      if (this.cover) {
        const img = this.cover, iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        const sc = (lr * 2) / Math.min(iw, ih), dw = iw * sc, dh = ih * sc;
        x.drawImage(img, o - dw / 2, o - dh / 2, dw, dh);
      } else {
        g = x.createLinearGradient(o - lr, o - lr, o + lr, o + lr);
        g.addColorStop(0, this.palette.colors[0]);
        g.addColorStop(0.55, this.palette.colors[1]);
        g.addColorStop(1, this.palette.colors[2]);
        x.fillStyle = g;
        x.fillRect(o - lr, o - lr, lr * 2, lr * 2);
        x.fillStyle = 'rgba(0,0,0,0.28)';
        x.fillRect(o - lr, o - lr * 0.09, lr * 2, lr * 0.18);
        x.fillStyle = 'rgba(255,255,255,0.85)';
        x.beginPath(); x.arc(o + lr * 0.62, o, lr * 0.06, 0, TAU); x.fill();
        x.beginPath(); x.arc(o - lr * 0.62, o, lr * 0.06, 0, TAU); x.fill();
      }
      x.restore();
      x.strokeStyle = 'rgba(255,255,255,0.28)';
      x.lineWidth = Math.max(1, 2 * s);
      circle(lr); x.stroke();

      x.fillStyle = '#000';
      circle(R * 0.045); x.fill();
      x.strokeStyle = 'rgba(255,255,255,0.45)';
      x.stroke();

      // 高光单独一层，不跟随唱片旋转
      const sh = this._sheen;
      sh.width = sh.height = D;
      const y = sh.getContext('2d');
      if (y.createConicGradient) {
        const cg = y.createConicGradient(-0.5, o, o);
        [[0, 0], [0.07, 0.17], [0.14, 0], [0.5, 0], [0.57, 0.17], [0.64, 0], [1, 0]].forEach((p) => {
          cg.addColorStop(p[0], 'rgba(255,255,255,' + p[1] + ')');
        });
        y.fillStyle = cg;
        y.beginPath();
        y.arc(o, o, R, 0, TAU);
        y.arc(o, o, lr, 0, TAU, true);
        y.fill();
      }
    }

    _drawDisc(ctx, L, hue, k, beat) {
      const key = Math.round(L.R) + '|' + this.palette.id + '|' + this._coverVer;
      if (key !== this._discKey) { this._buildDisc(L.R, L.s); this._discKey = key; }
      const D = this._disc.width;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(L.cx, L.cy);
      ctx.scale(k, k);
      ctx.save();
      ctx.rotate(this.angle);
      ctx.drawImage(this._disc, -D / 2, -D / 2);
      ctx.restore();
      ctx.drawImage(this._sheen, -D / 2, -D / 2);
      ctx.shadowColor = this.color(hue);
      ctx.shadowBlur = (18 + 40 * beat) * L.s;
      ctx.strokeStyle = this.color(hue);
      ctx.lineWidth = (3 + 5 * beat) * L.s;
      ctx.beginPath();
      ctx.arc(0, 0, L.R, 0, TAU);
      ctx.stroke();
      ctx.restore();
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }

    _drawBars(ctx, dt, a, L, S, hue) {
      const n = 48, x0 = L.barsX0, step = (L.barsX1 - x0) / n, base = L.barsBase, maxH = L.barsH;
      const pk = this.peaks;
      const g = ctx.createLinearGradient(0, base, 0, base - maxH);
      g.addColorStop(0, this.color(hue));
      g.addColorStop(1, this.color(hue + 0.33));
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = clamp(a.bars[Math.floor((i * 60) / n)] * S.react);
        pk[i] = Math.max(v, pk[i] - dt * 0.45);
        const x = x0 + (i + 0.5) * step;
        ctx.moveTo(x, base);
        ctx.lineTo(x, base - Math.max(1, v * maxH));
      }
      ctx.lineCap = 'round';
      ctx.strokeStyle = g;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = step * 1.25;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.lineWidth = step * 0.58;
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      const ph = Math.max(2, 3 * L.s);
      for (let i = 0; i < n; i++) {
        const x = x0 + (i + 0.5) * step;
        ctx.fillRect(x - step * 0.29, base - pk[i] * maxH - step * 0.45 - ph, step * 0.58, ph);
      }
    }

    _fit(ctx, text, weight, size, maxW) {
      ctx.font = weight + ' ' + size + 'px ' + FONT;
      let w = ctx.measureText(text).width;
      if (w > maxW) {
        size = Math.max(size * 0.5, (size * maxW) / w);
        ctx.font = weight + ' ' + size + 'px ' + FONT;
        w = ctx.measureText(text).width;
        while (w > maxW && text.length > 4) {
          text = text.slice(0, -2).trimEnd() + '…';
          w = ctx.measureText(text).width;
        }
      }
      return text;
    }

    _drawText(ctx, L, S, hue) {
      const title = (S.title || '').trim(), artist = (S.artist || '').trim();
      if (!title && !artist) return;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = 14 * L.s;
      if (title) {
        const t = this._fit(ctx, title, 700, 54 * L.s, L.textW);
        ctx.fillStyle = '#fff';
        ctx.fillText(t, L.cx, L.titleY);
      }
      if (artist) {
        const t = this._fit(ctx, artist, 500, 32 * L.s, L.textW);
        ctx.fillStyle = this.color(hue);
        ctx.fillText(t, L.cx, title ? L.artistY : L.titleY);
      }
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }

    _drawProgress(ctx, L, hue, p) {
      const x0 = L.barsX0, x1 = L.barsX1, y = L.progY, s = L.s;
      p = clamp(p || 0);
      ctx.lineCap = 'round';
      ctx.lineWidth = 4 * s;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      const xe = x0 + (x1 - x0) * p;
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, this.color(hue));
      g.addColorStop(1, this.color(hue + 0.33));
      ctx.strokeStyle = g;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(xe, y); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(xe, y, 6.5 * s, 0, TAU); ctx.fill();
    }
  }

  global.BeatVisuals = { Visualizer, PALETTES };
})(window);
