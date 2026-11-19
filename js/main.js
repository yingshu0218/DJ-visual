/*
 * BeatVision · 界面与流程
 * 载入音频 → 实时预览 → 调整风格 → 录制导出视频
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);

  const SCENES = [
    { id: 'tunnel', name: '霓虹隧道', icon: 'fa-circle-notch' },
    { id: 'kaleido', name: '万花筒', icon: 'fa-snowflake' },
    { id: 'liquid', name: '流体', icon: 'fa-droplet' },
    { id: 'stars', name: '星际穿越', icon: 'fa-star' },
    { id: 'synth', name: '合成波', icon: 'fa-sun' },
    { id: 'ripple', name: '声波涟漪', icon: 'fa-bullseye' },
    { id: 'ribbon', name: '旋律丝带', icon: 'fa-wind' },
    { id: 'laser', name: '激光', icon: 'fa-bolt' }
  ];
  const PALETTES = BeatVisuals.PALETTES;

  const DEFAULTS = {
    scene: 'tunnel', palette: 'neon', autoSwitch: 0,
    showDisc: true, showRing: true, showBars: true, showWave: true, showParticles: true, showProgress: true, showText: true,
    title: '', artist: '',
    react: 1, speed: 1, sens: 1, punch: 1, flash: 0.25, melody: 0.6,
    ratio: '9:16', res: 1080, fps: 30, clipDur: 30, fade: true
  };
  const KEY = 'beatvision.settings.v1';

  function loadSettings() {
    const s = Object.assign({}, DEFAULTS);
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || '{}');
      for (const k in DEFAULTS) if (k in o && typeof o[k] === typeof DEFAULTS[k]) s[k] = o[k];
    } catch (e) { /* 读取失败就用默认值 */ }
    if (!SCENES.some((x) => x.id === s.scene)) s.scene = DEFAULTS.scene;
    if (!PALETTES.some((x) => x.id === s.palette)) s.palette = DEFAULTS.palette;
    s.title = ''; // 曲名跟着音频走，不沿用上一次的
    return s;
  }
  function saveSettings() {
    try {
      const o = Object.assign({}, S);
      delete o.title;
      localStorage.setItem(KEY, JSON.stringify(o));
    } catch (e) { /* 隐私模式下可能写不进去，忽略 */ }
  }

  const S = loadSettings();
  const audio = new AudioEngine();
  const view = $('view');
  const vis = new BeatVisuals.Visualizer(view);

  let rec = null;        // 当前录制任务
  let titleAuto = true;  // 曲名是否仍由文件名自动填写
  let seeking = false;
  let guideOn = false;
  let resultUrl = '';
  let lastGain = 1;

  /* ---------------- 小工具 ---------------- */
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function parseTime(str) {
    str = String(str || '').trim().replace('：', ':');
    let m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(str);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = /^\d+(?:\.\d+)?$/.exec(str);
    return m ? Number(str) : NaN;
  }
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }
  function outSize() {
    const r = S.res, l = Math.round((r * 16) / 9);
    if (S.ratio === '1:1') return [r, r];
    if (S.ratio === '16:9') return [l, r];
    return [r, l];
  }

  /* ---------------- 录制格式 ---------------- */
  function pickMime() {
    if (!window.MediaRecorder || !view.captureStream) return '';
    const list = [
      'video/mp4;codecs=avc1.64002A,mp4a.40.2',
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.4D4028,mp4a.40.2',
      'video/mp4;codecs=avc1.42E028,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) || '';
  }
  const recMime = pickMime();
  const recIsMp4 = recMime.indexOf('mp4') >= 0;

  /* ---------------- 画布尺寸 ---------------- */
  function fitCanvas() {
    const area = $('canvasArea'), wrap = $('canvasWrap');
    const aw = area.clientWidth, ah = area.clientHeight;
    if (!aw || !ah) return;
    const [w, h] = outSize();
    const sc = Math.min(aw / w, ah / h);
    wrap.style.width = Math.floor(w * sc) + 'px';
    wrap.style.height = Math.floor(h * sc) + 'px';
  }
  function applySize() {
    const [w, h] = outSize();
    vis.setSize(w, h);
    fitCanvas();
    $('sizeLabel').textContent = w + '×' + h;
    updateGuide();
  }
  function updateGuide() {
    const portrait = S.ratio === '9:16';
    $('safeGuide').hidden = !(guideOn && portrait);
    $('btnGuide').classList.toggle('on', guideOn && portrait);
    $('btnGuide').disabled = !portrait;
    $('btnGuide').style.opacity = portrait ? '' : '0.4';
  }

  /* ---------------- 场景 / 配色 ---------------- */
  function setScene(id, flash) {
    S.scene = id;
    vis.setScene(id, flash);
    document.querySelectorAll('.scene-btn').forEach((b) => {
      const on = b.dataset.id === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    saveSettings();
  }
  function nextScene() {
    const i = SCENES.findIndex((x) => x.id === S.scene);
    setScene(SCENES[(i + 1) % SCENES.length].id);
  }
  function setPalette(id) {
    S.palette = id;
    vis.setPalette(id);
    const p = PALETTES.find((x) => x.id === id) || PALETTES[0];
    document.documentElement.style.setProperty('--c1', p.colors[0]);
    document.documentElement.style.setProperty('--c2', p.colors[1]);
    document.querySelectorAll('.pal-btn').forEach((b) => {
      const on = b.dataset.id === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    saveSettings();
  }

  function buildPickers() {
    const sg = $('sceneGrid');
    SCENES.forEach((sc) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'scene-btn';
      b.dataset.id = sc.id;
      b.setAttribute('role', 'radio');
      const i = document.createElement('i');
      i.className = 'fa-solid ' + sc.icon;
      const t = document.createElement('span');
      t.textContent = sc.name;
      b.append(i, t);
      b.addEventListener('click', () => setScene(sc.id));
      sg.appendChild(b);
    });
    const pr = $('paletteRow');
    PALETTES.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal-btn';
      b.dataset.id = p.id;
      b.title = p.name;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', p.name);
      b.style.background = 'conic-gradient(' + p.colors[0] + ', ' + p.colors[1] + ', ' + p.colors[2] + ', ' + p.colors[0] + ')';
      b.addEventListener('click', () => setPalette(p.id));
      pr.appendChild(b);
    });
  }

  /* ---------------- 设置项绑定 ---------------- */
  function updateOut(k) {
    const o = document.querySelector('[data-out="' + k + '"]');
    if (o) o.textContent = Number(S[k]).toFixed(2);
  }
  function bindControls() {
    document.querySelectorAll('[data-key]').forEach((el) => {
      const k = el.dataset.key;
      const isCheck = el.type === 'checkbox', isSel = el.tagName === 'SELECT';
      if (isCheck) el.checked = !!S[k];
      else {
        el.value = String(S[k]);
        if (isSel && el.selectedIndex < 0) { S[k] = DEFAULTS[k]; el.value = String(S[k]); }
      }
      updateOut(k);
      el.addEventListener(isCheck || isSel ? 'change' : 'input', () => {
        if (isCheck) S[k] = el.checked;
        else if (el.type === 'range' || el.dataset.type === 'number') S[k] = Number(el.value);
        else S[k] = el.value;
        updateOut(k);
        if (k === 'ratio' || k === 'res') applySize();
        if (k === 'title') titleAuto = false;
        saveSettings();
      });
    });
  }

  /* ---------------- 音频载入与播放 ---------------- */
  function isImage(f) { return /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|avif)$/i.test(f.name || ''); }

  let importGeneration = 0;
  async function loadAudioFile(file) {
    if (!file) return false;
    if (rec) { toast('正在录制中，请先停止录制'); return false; }
    const generation = ++importGeneration;
    audio.pause();
    $('fileName').textContent = '正在分析…';
    const result = await BeatAnalysis.request(file);
    if (generation !== importGeneration) return false;
    if (!result) { $('fileName').textContent = '分析未完成，请重试或重新选择音频'; return false; }
    $('fileName').textContent = '正在读取…';
    try {
      await audio.load(file);
      if (generation !== importGeneration || BeatAnalysis.result !== result) return false;
    } catch (e) {
      if (generation !== importGeneration) return false;
      $('fileName').textContent = audio.hasFile ? audio.name : '点击选择或拖入你的 DJ 音乐';
      toast(e.message || '无法读取这个音频文件');
      return false;
    }
    $('fileName').textContent = file.name || '已载入音频';
    if (titleAuto) {
      S.title = (file.name || '').replace(/\.[^.]+$/, '');
      $('title').value = S.title;
    }
    $('seek').disabled = false;
    $('seek').value = 0;
    $('timeDur').textContent = fmt(audio.duration);
    $('clipStart').value = '0:00';
    $('demoBadge').hidden = true;
    toast('分析完成，点击 ▶ 开始播放');
    return true;
  }

  function loadCover(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { vis.setCover(img); $('btnCoverClear').hidden = false; };
    img.onerror = () => { URL.revokeObjectURL(url); toast('这张图片无法读取，请换一张'); };
    img.src = url;
  }

  async function togglePlay() {
    if (rec) return;
    if (!audio.hasFile) { toast('先在右侧第 1 步选择音乐，或试试内置示例节拍'); return; }
    if (audio.playing) { audio.pause(); return; }
    if (audio.el.ended) audio.el.currentTime = 0;
    try { await audio.play(); } catch (e) { toast('无法播放：' + (e.message || e)); }
  }

  /* ---------------- 录制 ---------------- */
  function setRecUI(on) {
    document.body.classList.toggle('is-recording', on);
    $('btnRec').hidden = on;
    $('recActions').hidden = !on;
    $('recBadge').hidden = !on;
    $('btnPlay').disabled = on;
    $('seek').disabled = on || !audio.hasFile;
    document.querySelectorAll('.lock-on-rec select, .lock-on-rec input, .lock-on-rec button').forEach((el) => { el.disabled = on; });
  }

  async function startRecording() {
    if (rec) return;
    if (!audio.hasFile) { toast('请先在第 1 步载入音频'); return; }
    if (!recMime) { toast('当前浏览器不支持录制视频，请使用最新版 Chrome / Edge / Safari'); return; }
    const dur = audio.duration;
    const start = parseTime($('clipStart').value);
    if (!isFinite(start) || start < 0) { toast('片段起点请写成「分:秒」，例如 1:05'); return; }
    if (start > dur - 1) { toast('片段起点超出了音频长度（全长 ' + fmt(dur) + '）'); return; }
    const len = S.clipDur > 0 ? Math.min(S.clipDur, dur - start) : dur - start;

    audio.pause();
    await audio.seek(start);
    audio.resetAnalysis();
    audio.setOutputGain(1);
    lastGain = 1;

    let recorder, stream;
    try {
      const vTrack = view.captureStream(S.fps).getVideoTracks()[0];
      const aTrack = audio.recDest.stream.getAudioTracks()[0].clone();
      stream = new MediaStream([vTrack, aTrack]);
      const [w, h] = outSize();
      const bits = Math.max(5e6, Math.round(((w * h) / (1080 * 1920)) * 12e6 * (S.fps > 30 ? 1.4 : 1)));
      recorder = new MediaRecorder(stream, { mimeType: recMime, videoBitsPerSecond: bits, audioBitsPerSecond: 192000 });
    } catch (e) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      toast('无法开始录制：' + (e.message || e));
      return;
    }

    const r = { recorder, stream, chunks: [], start, len, t: 0, mime: recorder.mimeType || recMime, hidden: false, stopping: false, save: true, done: false };
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    recorder.onstop = () => finalize(r);
    recorder.onerror = () => { r.msg = '录制出错，已停止'; stopRecording(false); };
    rec = r;
    setRecUI(true);
    if (len > 600) toast('片段较长，生成的视频文件会很大');
    recorder.start(1000);
    try {
      await audio.play();
    } catch (e) {
      r.msg = '浏览器拦截了自动播放：请先点一下 ▶ 播放，再开始录制';
      stopRecording(false);
    }
  }

  function stopRecording(save) {
    const r = rec;
    if (!r || r.stopping) return;
    r.stopping = true;
    r.save = r.save && save;
    r.t = clamp(audio.el.currentTime - r.start, 0, r.len);
    audio.pause();
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    else finalize(r);
  }

  function finalize(r) {
    if (r.done) return;
    r.done = true;
    r.stream.getTracks().forEach((t) => t.stop());
    audio.setOutputGain(1);
    lastGain = 1;
    if (rec === r) rec = null;
    setRecUI(false);
    if (!r.save) { toast(r.msg || '已取消录制'); return; }
    const type = r.mime.split(';')[0] || 'video/webm';
    const blob = new Blob(r.chunks, { type });
    if (!blob.size) { toast('录制失败：没有得到视频数据，请重试'); return; }
    showResult(blob, r, type);
  }

  function showResult(blob, r, type) {
    const mp4 = type.indexOf('mp4') >= 0, ext = mp4 ? 'mp4' : 'webm';
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    const [w, h] = outSize();
    const base = (S.title || 'BeatVision').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'BeatVision';
    $('resultVideo').src = resultUrl;
    $('resultDownload').href = resultUrl;
    $('resultDownload').download = base + '_' + S.ratio.replace(':', 'x') + '.' + ext;
    $('resultInfo').textContent = w + '×' + h + ' · ' + S.fps + ' fps · 约 ' + Math.round(r.t) + ' 秒 · ' +
      (blob.size / 1048576).toFixed(1) + ' MB · ' + ext.toUpperCase();
    const warns = [];
    if (!mp4) warns.push('当前浏览器只能录成 WebM 格式，手机相册和 TikTok App 可能不识别，建议先转成 MP4 再发布（或改用最新版 Chrome / Edge / Safari 重新录制）。');
    if (mp4 && /vp0?9|vp8|av01|opus/i.test(r.mime)) warns.push('这个浏览器录出的 MP4 不是 H.264 编码，部分手机和 App 可能无法播放，建议改用最新版 Chrome / Edge / Safari 重新录制。');
    if (r.hidden) warns.push('录制期间页面曾切到后台，那一段画面可能卡住，建议重新录制。');
    $('resultWarn').textContent = warns.join(' ');
    $('resultWarn').hidden = !warns.length;
    $('resultModal').hidden = false;
  }

  function closeResult() {
    $('resultVideo').pause();
    $('resultModal').hidden = true;
  }

  /* ---------------- 主循环 ---------------- */
  let lastT = 0, uiT = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!lastT) { lastT = now; return; }
    if (now - lastT < 9) return; // 高刷新率屏幕上限制到约 60–90 帧，省 GPU
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    audio.sensitivity = S.sens;
    audio.update(dt);

    if (audio.beatHit && S.autoSwitch > 0 && audio.beatCount % S.autoSwitch === 0) nextScene();

    let progress, fade = 1;
    if (rec) {
      const t = audio.el.currentTime - rec.start;
      if (!rec.stopping) {
        rec.t = clamp(t, 0, rec.len);
        if (S.fade) {
          fade = clamp((rec.len - t) / 1.5);
          if (fade !== lastGain) { audio.setOutputGain(fade); lastGain = fade; }
        }
        if (t >= rec.len || audio.el.ended) stopRecording(true);
      }
      progress = clamp(t / rec.len);
    } else if (audio.hasFile) {
      progress = audio.duration ? audio.el.currentTime / audio.duration : 0;
    } else {
      progress = (vis.time % 30) / 30;
    }

    vis.render(dt, audio, S, { progress, fade });

    if (now - uiT > 100) {
      uiT = now;
      updateTransport();
    }
  }

  function updateTransport() {
    const playing = audio.playing;
    const icon = $('btnPlay').firstElementChild;
    const want = 'fa-solid ' + (playing ? 'fa-pause' : 'fa-play');
    if (icon.className !== want) icon.className = want;
    if (audio.hasFile) {
      const cur = audio.el.currentTime, dur = audio.duration;
      $('timeCur').textContent = fmt(cur);
      if (!seeking && dur) $('seek').value = Math.round((cur / dur) * 1000);
      $('bpmChip').textContent = audio.bpm ? Math.round(audio.bpm) + ' BPM' : '-- BPM';
    }
    if (rec) $('recText').textContent = 'REC ' + fmt(rec.t) + ' / ' + fmt(rec.len);
  }

  /* ---------------- 事件 ---------------- */
  function bindEvents() {
    $('fileAudio').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) loadAudioFile(f);
    });
    $('fileCover').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) loadCover(f);
    });
    $('btnCoverClear').addEventListener('click', () => { vis.setCover(null); $('btnCoverClear').hidden = true; });

    $('btnDemo').addEventListener('click', async () => {
      if (rec) { toast('正在录制中，请先停止录制'); return; }
      const b = $('btnDemo');
      b.disabled = true;
      try {
        const f = await BeatDemo.make();
        await loadAudioFile(f);
      } catch (e) {
        toast(e.message || '示例节拍生成失败');
      }
      b.disabled = false;
    });

    $('btnPlay').addEventListener('click', togglePlay);
    $('seek').addEventListener('input', () => {
      seeking = true;
      if (audio.duration) {
        const t = ($('seek').value / 1000) * audio.duration;
        audio.el.currentTime = t;
        $('timeCur').textContent = fmt(t);
      }
    });
    $('seek').addEventListener('change', () => { seeking = false; });

    $('btnGuide').addEventListener('click', () => { guideOn = !guideOn; updateGuide(); });
    $('btnUseCur').addEventListener('click', () => {
      if (!audio.hasFile) { toast('请先载入音频'); return; }
      $('clipStart').value = fmt(audio.el.currentTime);
    });

    $('btnRec').addEventListener('click', startRecording);
    $('btnRecStop').addEventListener('click', () => stopRecording(true));
    $('btnRecCancel').addEventListener('click', () => stopRecording(false));
    $('resultClose').addEventListener('click', closeResult);
    $('resultModal').addEventListener('click', (e) => { if (e.target === $('resultModal')) closeResult(); });

    // 页面切到后台时 requestAnimationFrame 会停，用音频自身的事件兜底结束录制
    audio.el.addEventListener('timeupdate', () => {
      if (rec && !rec.stopping && audio.el.currentTime - rec.start >= rec.len) stopRecording(true);
    });
    audio.el.addEventListener('ended', () => { if (rec && !rec.stopping) stopRecording(true); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && rec) rec.hidden = true; });

    // 浏览器要求有用户手势才允许出声：任何一次点击 / 按键都尝试唤醒音频
    const wake = () => { if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {}); };
    document.addEventListener('pointerdown', wake);
    document.addEventListener('keydown', wake);

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'a') return;
      e.preventDefault();
      togglePlay();
    });

    // 拖放：音频 → 载入；图片 → 唱片封面
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      $('dropOverlay').hidden = false;
      $('dropzone').classList.add('over');
    });
    document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    const endDrag = () => { dragDepth = 0; $('dropOverlay').hidden = true; $('dropzone').classList.remove('over'); };
    document.addEventListener('dragleave', () => { if (--dragDepth <= 0) endDrag(); });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      endDrag();
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (isImage(f)) loadCover(f);
      else loadAudioFile(f);
    });

    window.addEventListener('resize', fitCanvas);
    if (window.ResizeObserver) new ResizeObserver(fitCanvas).observe($('canvasArea'));
  }

  /* ---------------- 启动 ---------------- */
  buildPickers();
  bindControls();
  bindEvents();
  setPalette(S.palette);
  setScene(S.scene, false);
  applySize();
  vis.precompile();

  if (!recMime) {
    $('formatLabel').textContent = '当前浏览器不支持录制';
    $('btnRec').disabled = true;
  } else {
    $('formatLabel').textContent = !recIsMp4 ? 'WebM（当前浏览器不支持直接录 MP4）' : /avc1/.test(recMime) ? 'MP4（H.264 + AAC）' : 'MP4';
  }
  if (document.fonts && document.fonts.load) document.fonts.load('700 48px Orbitron').catch(() => {});

  requestAnimationFrame(frame);

  // 调试入口（在浏览器控制台里可以查看内部状态）
  window.BeatVision = {
    audio, vis, settings: S, loadAudioFile, startRecording, stopRecording,
    get recording() { return !!rec; },
    recMime
  };
})();
