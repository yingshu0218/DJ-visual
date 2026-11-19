# BeatVision · 独立本地音频分析阶段 v1

这是原静态项目的独立副本。新增「导入 → 本地离线分析 → 只读结果 → 点击播放」流程；原有实时视觉、设置和录制功能保留。没有新增音频剪辑、手调拍点、拖拽时间线或视频编辑器，也没有把新分析结果接入旧渲染／录制路径。

## 使用

直接用支持 Web Audio 的浏览器打开 `index.html`，无需构建、安装依赖或后端。也可在本目录运行 `python3 -m http.server 8000`，打开 `http://localhost:8000`。这只是本机静态服务。

1. 选择或拖入音频，或点击「内置示例节拍」。自动先分析，不自动播放。
2. 查看读取／解码／分析进度；可取消，失败可重试同一文件或选择另一文件。
3. 只读结果包括总长、BPM 候选与不确定原因、低频起音时间、整首能量图、较高能量区间与明显能量上升候选。
4. 分析完成后点击原有播放键；之后可继续使用原功能。本阶段未新增导出按钮。原视频录制流程未改造，仍需要单独验收。

结果中的「节拍」是检测到的低频起音候选，不是精确拍网格；「高潮」只是能量候选，不代表精确 Drop。能量图横轴和所有时间均从音频开头算起。

音频和分析数据只留在当前页面内存，不发送到服务器，刷新丢失。旧页面依然引用 Google 字体及 jsDelivr 图标资源：**音频分析无需网络，但整页不是完全无外部资源的离线包**；断网时字体或图标可能回退／缺失。

## 分析方法与边界

- 原生 `OfflineAudioContext.decodeAudioData` 解码／重采样至 11025 Hz；按固定约 10ms 采样窗计算能量与低频包络，完全不使用 requestAnimationFrame 或实时播放器位置。
- 多声道功率平均，避免左右声道反相相消。低通包络正向变化检测起音，局部阈值和 220ms 最小间隔抑制重复候选。结果时间精度约 10ms，不保证音乐学意义的拍点准确度。
- 根据低频起音间隔估计速度候选；半速／倍速都成立时 `tempo.bpm=null`、`status=ambiguous`，列候选而不强选。稳定度是启发式指标，不是 BPM 正确概率。缺鼓、节奏变化、切分及很短的文件通常不明确。持续音调／静音不补造拍网格。
- 低于 4 秒只给可用能量与起音信息，不推断 BPM；接近静音时不生成节奏或高潮候选。
- 能量以 dBFS 表示（不是 LUFS），按至少 0.5 秒、最多约 600 个分箱展示。相比前两箱上升至少 6 dB 且高于 −40 dBFS 的区域标记为上升候选。能量分布有至少 3 dB 变化时，最高约 20% 且高于 −40 dBFS 的连续分箱标为较高能量区间。最多返回 100 个能量候选。
- 上限：48 MiB 输入、10 分钟、单／双声道。先读元数据校验时长，再低采样率解码；解码后再次检查。计算每约 2 秒采样批次让出主线程，起音检测也分批让出。
- 原生解码不可强制中断；取消后忽略结果，新任务等待当前解码释放。始终仅一个执行任务和一个可替换待执行文件，不并行积压解码。每次换文件立即清除旧分析结果，旧成功／失败／进度不能覆盖新状态。浏览器原生解码的瞬时内存由浏览器管理，极端文件仍建议关闭页面后换文件；这些限制不是严格内存沙箱。

## 结构化接口（供后续视频阶段使用）

`window.BeatAnalysis.result`：最新成功结果，未完成／取消／失败为 `null`。`window.BeatAnalysis.state`：`idle | loading | ready | error`，含最新请求 id、文件名、进度／消息和结果。每次状态变化发出 `beatvision:analysis` CustomEvent，`event.detail` 为该状态。消费方应把对象当只读数据，不更改它。

```js
window.addEventListener('beatvision:analysis', event => {
  const state = event.detail;
  if (state.status === 'ready') console.log(state.result);
});
```

结果结构：

```text
schemaVersion: 1
algorithmVersion: "1.0.0"
timeUnit: "seconds"
duration, sampleRate, channels
source: { name, sizeBytes }
tempo: { bpm: number|null, status, confidence, confidenceMeaning, reason,
         candidates: [{ bpm, relation }] }
beats: { kind: "detected-low-frequency-onsets", confirmedGrid: false,
         toleranceSeconds, times: number[] }
energy: { binSeconds, unit: "dBFS", bins: [{ start, end, rms, dbFS }] }
candidates: [{ time, end, type: "energy-rise"|"high-energy", deltaDb? }]
warnings: string[]
summary: { silent, rms, peak }
limits: { maxDuration, maxBytes, sampleRate }
```

`tempo.status` 可为 `silent / too-short / unclear / ambiguous / estimated`。`bpm` 为空时只允许展示候选，不应由后续视频模块偷偷选定一个拍速。`beats.times` 是实际检测事件；不要将它误读为覆盖整首的均匀拍网格。

## 文件与验证

新增 `js/analysis-core.js`（纯算法）、`js/analysis-controller.js`（任务隔离）、`js/analysis-ui.js`（解码和只读显示）、`tests/`。原 `main.js` 仅修改音频导入入口，HTML/CSS 添加分析面板。`audio.js`、`demo.js`、`shaders.js`、`visuals.js` 及 `main.js` 的录制实现与原附件一致。

源码直接可读。自动测试只需已有 Node.js 18+，不需要 npm install：

```sh
node --test tests/*.test.cjs
node --check js/analysis-core.js
node --check js/analysis-controller.js
node --check js/analysis-ui.js
node --check js/main.js
```

2026-11-19：20 项自动测试通过，8 个 JS 文件语法检查通过。测试全部使用现场合成 PCM，不含私人音乐或其他项目音频。合成信号不代表复杂 DJ 曲目准确率。

覆盖：120/60 BPM 脉冲与半速歧义、静音、短音轨、无鼓持续音、反相双声道、音频第 6 秒能量跃迁、不同调度下结果一致、取消、中间任务合并、旧成功／错误／进度隔离、失败后恢复、分析完成后才进入原播放器、DOM ID 和本地资源一致性。

**未验证：**真实浏览器文件解码、可见交互、图表及桌面／窄屏布局、音频格式兼容性、Safari/iOS、真机性能和视频录制。当前测试环境 Chromium 启动报 `socket() failed: Operation not permitted`，因此只完成算法及带明确桩对象的状态集成测试，不把这些测试称为真实播放／录制测试。未复用旧 README 的浏览器结果。

真实浏览器后续检查清单：

- 点示例节拍，观察加载 → 分析 → 完成；确认不自动播放，点击播放后正常播放。
- 连续选择 A/B/C，确认只展示 C 的结果；分析中取消，再选择新文件；坏文件失败后点重试或换文件。
- 导入 2 秒、静音、无鼓旋律、60/120 BPM 素材；检查不明确说明。
- 在 1440×1000 与 390×844 检查图表、长文件名、详情滚动、取消／重试按钮与原控制项。
- 网络面板确认无音频上传；断网检查分析。另行验收原视频导出音轨、帧变化、时长与实际帧率。

此源码版本未部署，原附件保持不变。
