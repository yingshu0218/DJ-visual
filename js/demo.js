/*
 * BeatVision · 内置示例节拍
 * 在浏览器里即时合成一段约 30 秒、126 BPM 的 House 律动（底鼓 / 镲 / 拍手 / 贝斯 / 琶音），
 * 让你在没有上传音频时也能完整体验「音频 → 画面 → 导出」的流程。
 */
(function (global) {
  'use strict';

  function encodeWav(buf) {
    const ch = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
    const bytes = 44 + len * ch * 2;
    const dv = new DataView(new ArrayBuffer(bytes));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, len * ch * 2, true);
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([dv], { type: 'audio/wav' });
  }

  async function make() {
    const OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) throw new Error('当前浏览器无法合成示例节拍');
    const sr = 44100, bpm = 126, beat = 60 / bpm, bars = 16;
    const dur = bars * 4 * beat + 0.6;
    const ctx = new OAC(2, Math.ceil(dur * sr), sr);

    const master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);

    const noise = ctx.createBuffer(1, sr, sr);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    const env = (g, t, peak, len) => {
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
    };
    const kick = (t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(165, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      env(g, t, 1, 0.38);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.4);
    };
    const noiseHit = (t, type, freq, peak, len) => {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise;
      f.type = type; f.frequency.value = freq;
      env(g, t, peak, len);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t, Math.random() * 0.5, len + 0.05);
    };
    const tone = (t, type, freq, cutoff, peak, len) => {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      f.type = 'lowpass'; f.frequency.value = cutoff;
      env(g, t, peak, len);
      o.connect(f); f.connect(g); g.connect(master);
      o.start(t); o.stop(t + len + 0.02);
    };

    // A 小调琶音，后半段换一组和声，让「旋律变色」有东西可跟
    const arpA = [0, 3, 7, 12, 10, 7, 3, 7];
    const arpB = [-4, 0, 3, 8, 7, 3, 0, 3];
    const bassA = 55, bassB = 43.65;

    for (let b = 0; b < bars * 4; b++) {
      const t = b * beat, bar = Math.floor(b / 4);
      const second = bar % 4 >= 2;
      const breakdown = bar === 8; // 第 9 小节抽掉底鼓，做一个小 break
      if (!breakdown) kick(t);
      noiseHit(t + beat / 2, 'highpass', 7000, 0.22, 0.05);
      if (bar >= 1 && b % 2 === 1) noiseHit(t, 'bandpass', 1600, 0.4, 0.16);
      if (bar >= 2) tone(t + beat / 2, 'sawtooth', second ? bassB : bassA, 420, 0.36, beat * 0.42);
      if (bar >= 4) {
        const arp = second ? arpB : arpA;
        for (let s = 0; s < 4; s++) {
          const n = arp[(b * 4 + s) % arp.length] + (bar >= 12 ? 12 : 0);
          tone(t + (s * beat) / 4, 'square', 440 * Math.pow(2, n / 12), 2600, 0.075, 0.13);
        }
      }
    }

    const buf = await ctx.startRendering();
    const blob = encodeWav(buf);
    try {
      return new File([blob], '示例节拍 Demo Beat.wav', { type: 'audio/wav' });
    } catch (e) {
      blob.name = '示例节拍 Demo Beat.wav';
      return blob;
    }
  }

  global.BeatDemo = { make };
})(window);
