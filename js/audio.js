/*
 * BeatVision · 音频分析引擎
 * 负责：播放音频、实时频谱分析、节拍检测、BPM 估算、旋律重心（用于变色）。
 * 输出的所有数值都归一化到 0..1，供视觉引擎直接使用。
 */
(function (global) {
  'use strict';

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);

  // 带独立「起音 / 释音」速度的平滑跟随
  function follow(cur, target, dt, atk, rel) {
    const rate = target > cur ? atk : rel;
    return cur + (target - cur) * (1 - Math.exp(-dt * rate));
  }

  // 自适应动态范围：不同母带响度的歌都能得到饱满的 0..1 变化
  class RangeTracker {
    constructor(minRange, drift) {
      this.minRange = minRange || 0.12;
      this.drift = drift || 0.015;
      this.reset();
    }
    reset() { this.lo = 1; this.hi = 0; }
    norm(v, dt) {
      this.hi = Math.max(v, this.hi - dt * this.drift);
      this.lo = Math.min(v, this.lo + dt * this.drift);
      const range = Math.max(this.hi - this.lo, this.minRange);
      return clamp((v - this.lo) / range);
    }
  }

  const N_BARS = 64;
  const N_WAVE = 512;

  class AudioEngine {
    constructor() {
      this.el = document.createElement('audio');
      this.el.preload = 'auto';
      this.el.setAttribute('playsinline', '');

      this.ctx = null;
      this.hasFile = false;
      this.name = '';
      this.sensitivity = 1;

      // —— 对外输出 ——
      this.bars = new Float32Array(N_BARS); // 对数分布的频谱柱（低频 → 高频）
      this.wave = new Float32Array(N_WAVE); // 波形 -1..1
      this.bass = 0;      // 低频（底鼓 / 贝斯）
      this.mid = 0;       // 中频（旋律 / 人声）
      this.high = 0;      // 高频（镲片 / 空气感）
      this.level = 0;     // 整体能量
      this.beat = 0;      // 节拍包络：命中瞬间为 1，随后衰减
      this.beatHit = false; // 本帧是否刚好命中节拍
      this.beatCount = 0;
      this.centroid = 0.5; // 频谱重心（旋律高低），0..1
      this.bpm = 0;

      this._rB = new RangeTracker(0.14, 0.02);
      this._rM = new RangeTracker(0.12, 0.012);
      this._rH = new RangeTracker(0.12, 0.012);
      this._rL = new RangeTracker(0.15, 0.008);
      this._rC = new RangeTracker(0.18, 0.01);
      this._fluxAvg = 0;
      this._fluxPeak = 0;
      this._onset = 0;
      this._primed = false;
      this._lastBeatT = -9;
      this._intervals = [];
      this._barPeak = 0.4;
      this._simT = 0;
      this._simBeat = -1;
    }

    get duration() {
      const d = this.el.duration;
      return this.hasFile && isFinite(d) ? d : 0;
    }
    get playing() {
      return this.hasFile && !this.el.paused && !this.el.ended;
    }

    _initGraph() {
      if (this.ctx) return;
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) throw new Error('当前浏览器不支持 Web Audio，无法分析音频');
      const ctx = (this.ctx = new AC());
      this.src = ctx.createMediaElementSource(this.el);

      this._createAnalysers(ctx);

      this.outGain = ctx.createGain();           // 片尾淡出用
      this.recDest = ctx.createMediaStreamDestination(); // 录制用的音轨

      this.src.connect(this.analyser);
      this.src.connect(this.beatAnalyser);
      this.src.connect(this.outGain);
      this.outGain.connect(ctx.destination);
      this.outGain.connect(this.recDest);

    }

    // 两个分析器：大窗口看频谱细节，小窗口抓鼓点（延迟更低）
    _createAnalysers(ctx) {
      const mk = (size) => {
        const a = ctx.createAnalyser();
        a.fftSize = size;
        a.smoothingTimeConstant = 0; // 平滑在下面按真实时间计算，结果不依赖屏幕刷新率
        // 满刻度正弦在 AnalyserNode 里大约是 -13 dB，这样设置可以避免响亮的低频被压成一条平线
        a.minDecibels = -85;
        a.maxDecibels = -12;
        return a;
      };
      this.analyser = mk(4096);
      this.beatAnalyser = mk(2048);
      this._setupAnalysis(ctx.sampleRate);
    }

    _setupAnalysis(sampleRate) {
      const an = this.analyser;
      const n = an.frequencyBinCount;
      this._freq = new Uint8Array(n);
      this._td = new Uint8Array(an.fftSize);

      // 鼓点检测用的小窗口频谱
      const ab = this.beatAnalyser, bHz = sampleRate / ab.fftSize;
      this._bf = new Uint8Array(ab.frequencyBinCount);
      this._bPrev = new Float32Array(ab.frequencyBinCount);
      this._b0 = Math.max(1, Math.round(35 / bHz));
      this._b1 = Math.max(this._b0 + 1, Math.round(170 / bHz));
      // 字节刻度（dB）→ 线性功率：在线性域里底鼓比贝斯突出得多，更容易分开
      this._pow = new Float32Array(256);
      for (let i = 0; i < 256; i++) this._pow[i] = Math.pow(10, ((i / 255 - 1) * 73) / 10);

      // 预计算对数频段边界（以 bin 为单位）
      const binHz = sampleRate / an.fftSize;
      const fMin = 35, fMax = Math.min(15000, sampleRate / 2 - 500);
      this._edges = new Float32Array(N_BARS + 1);
      for (let i = 0; i <= N_BARS; i++) {
        this._edges[i] = (fMin * Math.pow(fMax / fMin, i / N_BARS)) / binHz;
      }
      this._binHz = binHz;
    }

    async load(file) {
      this._initGraph();
      this.el.pause();
      if (this._url) URL.revokeObjectURL(this._url);
      this._url = URL.createObjectURL(file);
      const el = this.el;
      await new Promise((resolve, reject) => {
        const done = (fn, arg) => {
          el.removeEventListener('loadedmetadata', ok);
          el.removeEventListener('error', bad);
          fn(arg);
        };
        const ok = () => done(resolve);
        const bad = () => done(reject, new Error('无法读取这个音频文件，请换成 MP3 / WAV / M4A 再试'));
        el.addEventListener('loadedmetadata', ok);
        el.addEventListener('error', bad);
        el.src = this._url;
        el.load();
      });
      this.hasFile = true;
      this.name = file.name || '';
      this.resetAnalysis();
    }

    resetAnalysis() {
      this._rB.reset(); this._rM.reset(); this._rH.reset(); this._rL.reset(); this._rC.reset();
      this._fluxAvg = 0;
      this._fluxPeak = 0;
      this._onset = 0;
      this._primed = false;
      this._lastBeatT = -9;
      this._intervals.length = 0;
      this._barPeak = 0.4;
      this.bpm = 0;
      this.beatCount = 0;
      if (this._bPrev) this._bPrev.fill(0);
    }

    async play() {
      if (!this.hasFile) return;
      // 不等待 resume()：浏览器在没有用户手势时会让它一直挂起，main.js 里有手势兜底
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      await this.el.play();
    }
    pause() { this.el.pause(); }

    seek(t) {
      const el = this.el;
      return new Promise((resolve) => {
        if (Math.abs(el.currentTime - t) < 0.005) return resolve();
        let finished = false;
        const fin = () => {
          if (finished) return;
          finished = true;
          el.removeEventListener('seeked', fin);
          resolve();
        };
        el.addEventListener('seeked', fin);
        el.currentTime = t;
        setTimeout(fin, 1500);
      });
    }

    setOutputGain(v) {
      if (!this.ctx) return;
      this.outGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
    }

    // 每帧调用一次
    update(dt) {
      if (this.playing) this._analyze(dt);
      else if (!this.hasFile) this._simulate(dt);
      else this._idle(dt);
    }

    _analyze(dt) {
      const an = this.analyser, f = this._freq, n = f.length, binHz = this._binHz;
      an.getByteFrequencyData(f);
      an.getByteTimeDomainData(this._td);

      const band = (lo, hi) => {
        const i0 = Math.max(1, Math.round(lo / binHz));
        const i1 = Math.min(n - 1, Math.round(hi / binHz));
        let s = 0;
        for (let i = i0; i <= i1; i++) s += f[i];
        return s / ((i1 - i0 + 1) * 255);
      };
      const rb = band(35, 150), rm = band(300, 2500), rh = band(5000, 14000);

      // —— 节拍检测：低频能量的「瞬间上升量」——
      const ab = this.beatAnalyser, bf = this._bf, bp = this._bPrev, P = this._pow;
      ab.getByteFrequencyData(bf);
      let flux = 0;
      for (let i = this._b0; i <= this._b1; i++) {
        const p = P[bf[i]], d = p - bp[i];
        if (d > 0) flux += d;
        bp[i] = p;
      }
      if (!this._primed) { this._primed = true; flux = 0; } // 第一帧没有可比较的上一帧
      // 60ms 漏积分：把一次起音的上升量攒在一起，不受屏幕刷新率影响
      const on = (this._onset = this._onset * Math.exp(-dt / 0.06) + flux);
      const sens = this.sensitivity || 1;
      // 阈值同时参考「平均水平」和「近期最强的一击」，把底鼓和夹在中间的反拍贝斯区分开
      const thr = Math.max(this._fluxAvg * 1.8, this._fluxPeak * Math.exp(-dt / 2.5) * 0.4, 2e-4) / sens;
      this._fluxAvg += (on - this._fluxAvg) * (1 - Math.exp(-dt / 1.0));
      this._fluxPeak = Math.max(on, this._fluxPeak * Math.exp(-dt / 2.5));
      const now = an.context.currentTime, gap = now - this._lastBeatT;
      this.beatHit = false;
      if (on > thr && gap > 0.23) {
        this.beatHit = true;
        this.beat = 1;
        this.beatCount++;
        if (gap < 2) {
          this._intervals.push(gap);
          if (this._intervals.length > 24) this._intervals.shift();
          this._updateBpm();
        }
        this._lastBeatT = now;
      } else {
        this.beat *= Math.exp(-dt * 5.5);
      }

      // —— 各频段能量 ——
      this.bass = follow(this.bass, this._rB.norm(rb, dt), dt, 60, 9);
      this.mid = follow(this.mid, this._rM.norm(rm, dt), dt, 30, 6);
      this.high = follow(this.high, this._rH.norm(rh, dt), dt, 40, 10);
      // 整体能量：用波形的真实响度（RMS），-40 dB → 0，-10 dB → 1
      const tdv = this._td;
      let sq = 0;
      for (let i = tdv.length - 2048; i < tdv.length; i += 2) { const s = (tdv[i] - 128) / 128; sq += s * s; }
      const loud = clamp((10 * Math.log10(sq / 1024 + 1e-9) + 40) / 30);
      this.level = follow(this.level, 0.5 * loud + 0.5 * this._rL.norm(loud, dt), dt, 12, 3);

      // —— 频谱重心（旋律的高低走向）——
      const c0 = Math.round(120 / binHz), c1 = Math.min(n - 1, Math.round(8000 / binHz));
      let num = 0, den = 0;
      for (let i = c0; i <= c1; i++) { num += f[i] * i; den += f[i]; }
      if (den > 0) {
        const hz = (num / den) * binHz;
        const c = clamp(Math.log2(hz / 120) / Math.log2(8000 / 120));
        this.centroid = follow(this.centroid, this._rC.norm(c, dt), dt, 3.5, 3.5);
      }

      // —— 频谱柱 ——
      const e = this._edges, bars = this.bars;
      const gain = 1 / Math.max(this._barPeak, 0.35); // 自动增益：让最高的柱子接近顶格
      let peak = 0;
      for (let i = 0; i < N_BARS; i++) {
        const lo = e[i], hi = e[i + 1];
        let v;
        if (hi - lo < 1.5) {
          const c = (lo + hi) / 2, j = Math.floor(c), fr = c - j;
          v = f[j] * (1 - fr) + f[Math.min(n - 1, j + 1)] * fr;
        } else {
          let m = 0;
          for (let j = Math.floor(lo); j < hi && j < n; j++) if (f[j] > m) m = f[j];
          v = m;
        }
        v = (v / 255) * (0.8 + 0.5 * (i / N_BARS)); // 轻微补偿高频
        v = Math.pow(clamp(v), 2.2);
        if (v > peak) peak = v;
        bars[i] = follow(bars[i], Math.min(1, v * gain), dt, 45, 7);
      }
      this._barPeak = Math.max(peak, this._barPeak - dt * 0.03);

      // —— 波形 ——
      const td = this._td, w = this.wave, off = td.length - N_WAVE * 4;
      for (let i = 0; i < N_WAVE; i++) w[i] = (td[off + i * 4] - 128) / 128;
    }

    _updateBpm() {
      const arr = this._intervals;
      if (arr.length < 6) return;
      const sorted = arr.slice().sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      // 取中位数附近的间隔求平均，抵消「按帧取样」带来的误差
      let sum = 0, cnt = 0;
      for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i] - med) < med * 0.12) { sum += arr[i]; cnt++; }
      let bpm = 60 / (cnt ? sum / cnt : med);
      while (bpm < 85) bpm *= 2;
      while (bpm > 185) bpm /= 2;
      this.bpm = this.bpm ? this.bpm + (bpm - this.bpm) * 0.3 : bpm;
    }

    // 已载入音频但处于暂停：画面平静下来
    _idle(dt) {
      this.beatHit = false;
      this.beat *= Math.exp(-dt * 5.5);
      this.bass = follow(this.bass, 0, dt, 9, 5);
      this.mid = follow(this.mid, 0, dt, 9, 4);
      this.high = follow(this.high, 0, dt, 9, 6);
      this.level = follow(this.level, 0, dt, 9, 2.5);
      for (let i = 0; i < N_BARS; i++) this.bars[i] = follow(this.bars[i], 0, dt, 9, 5);
      for (let i = 0; i < N_WAVE; i++) this.wave[i] *= 0.88;
    }

    // 还没有音频：用一段合成的 126 BPM 律动驱动演示动画
    _simulate(dt) {
      this._simT += dt;
      const t = this._simT, ph = t * (126 / 60), idx = Math.floor(ph), fr = ph - idx;
      this.beatHit = idx !== this._simBeat;
      this._simBeat = idx;
      if (this.beatHit) { this.beat = 1; this.beatCount++; } else this.beat *= Math.exp(-dt * 5.5);

      const kick = Math.exp(-fr * 5);
      const hat = Math.exp(-((fr + 0.5) % 1) * 9);
      const sw = 0.5 + 0.5 * Math.sin(t * 0.35);
      this.bass = follow(this.bass, kick, dt, 60, 9);
      this.mid = follow(this.mid, clamp(0.35 + 0.35 * sw + 0.2 * Math.sin(t * 2.3)), dt, 20, 6);
      this.high = follow(this.high, hat * 0.8, dt, 40, 10);
      this.level = follow(this.level, 0.45 + 0.3 * kick + 0.15 * sw, dt, 10, 3);
      this.centroid = 0.5 + 0.45 * Math.sin(t * 0.23);
      this.bpm = 126;

      for (let i = 0; i < N_BARS; i++) {
        const x = i / N_BARS;
        const v = kick * Math.pow(1 - x, 2.2) * 0.95 +
          (0.28 + 0.22 * Math.sin(t * 2.1 + i * 0.45) + 0.15 * Math.sin(t * 3.7 - i * 0.21)) *
          (0.3 + 0.7 * Math.sin(Math.PI * clamp(x * 1.1))) * (0.45 + 0.55 * sw) +
          hat * 0.45 * Math.pow(x, 3);
        this.bars[i] = follow(this.bars[i], clamp(v), dt, 45, 7);
      }
      for (let i = 0; i < N_WAVE; i++) {
        const u = i / N_WAVE;
        this.wave[i] = Math.sin(u * 14 + t * 6) * 0.38 * kick +
          Math.sin(u * 46 + t * 9) * 0.16 * (0.4 + sw) +
          Math.sin(u * 120 - t * 13) * 0.08 * hat;
      }
    }
  }

  AudioEngine.N_BARS = N_BARS;
  AudioEngine.N_WAVE = N_WAVE;
  global.AudioEngine = AudioEngine;
})(window);
