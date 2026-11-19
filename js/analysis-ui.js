(function(){
  'use strict';
  const $=id=>document.getElementById(id), core=BeatAnalysisCore;
  const stamp=t=>Math.floor(t/60)+':'+(t%60).toFixed(2).padStart(5,'0');
  let lastFile=null;
  function metadata(file,cancelled){return new Promise((resolve,reject)=>{
    const el=document.createElement('audio'),url=URL.createObjectURL(file);let done=false;
    const finish=(error,duration)=>{if(done)return;done=true;clearTimeout(timer);clearInterval(poll);el.removeAttribute('src');el.load();URL.revokeObjectURL(url);error?reject(error):resolve(duration);};
    const timer=setTimeout(()=>finish(new Error('读取音频信息超时，请重试或换成 WAV / MP3')),15000);
    const poll=setInterval(()=>{if(cancelled())finish(new Error('分析已取消'));},100);
    el.onloadedmetadata=()=>finish(null,el.duration);el.onerror=()=>finish(new Error('浏览器无法读取此文件，请换成 WAV / MP3'));el.preload='metadata';el.src=url;
  });}
  async function run(file,cancelled,progress){
    const check=()=>{if(cancelled())throw new Error('分析已取消');};
    if(file.size>core.LIMITS.maxBytes)throw new Error('文件超过 48 MiB 分析上限，请选择较小的音频');
    if(!file.size)throw new Error('文件为空，请重新选择');
    progress('读取本地音频信息…',0.02);const duration=await metadata(file,cancelled);check();
    if(!Number.isFinite(duration)||duration<=0)throw new Error('无法确定音频长度，请换成 WAV / MP3');
    if(duration>core.LIMITS.maxDuration)throw new Error('本阶段支持最长 10 分钟音频，请选择较短的文件');
    const OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
    if(!OAC)throw new Error('当前浏览器不支持离线解码，请换用支持 Web Audio 的浏览器');
    progress('本地解码中；换文件会自动丢弃旧结果…',0.08);
    // Native decoding is not cancellable. Controller serializes it, retaining only the latest pending file.
    const bytes=await file.arrayBuffer();check();
    const context=new OAC(1,1,core.LIMITS.sampleRate);let decoded=await context.decodeAudioData(bytes);check();
    if(decoded.duration>core.LIMITS.maxDuration+0.01||decoded.numberOfChannels>2)throw new Error('本阶段支持最长 10 分钟的单声道／双声道音频');
    const channels=Array.from({length:decoded.numberOfChannels},(_,i)=>decoded.getChannelData(i));
    const result=await core.analyze(channels,decoded.sampleRate,{cancelled,progress:p=>progress('分析节奏与能量…',0.15+p*0.85)});
    decoded=null;check();return {...result,source:{name:file.name||'本地音频',sizeBytes:file.size}};
  }
  function drawEnergy(result){
    const svg=$('analysisEnergy');svg.replaceChildren();const ns='http://www.w3.org/2000/svg';
    const bins=result.energy.bins;const points=bins.map(b=>`${40+((b.start+b.end)/2/result.duration)*520},${110-(Math.max(-60,b.dbFS)+60)/60*90}`).join(' ');
    const poly=document.createElementNS(ns,'polyline');poly.setAttribute('points',points);poly.setAttribute('fill','none');poly.setAttribute('stroke','#00e5ff');poly.setAttribute('stroke-width','2');svg.append(poly);
    for(const [x,y,text] of [[2,24,'0 dB'],[2,110,'−60'],[40,137,'0:00'],[490,137,stamp(result.duration)]]) {const t=document.createElementNS(ns,'text');t.setAttribute('x',x);t.setAttribute('y',y);t.setAttribute('fill','currentColor');t.setAttribute('font-size','11');t.textContent=text;svg.append(t);}
  }
  function render(state){
    $('analysisStatus').textContent=state.status==='ready'?'分析完成 · '+state.name:state.message||'选择音频后自动开始分析';
    $('analysisProgress').hidden=state.status!=='loading';$('analysisProgress').value=state.progress||0;
    $('analysisCancel').hidden=state.status!=='loading';$('analysisRetry').hidden=state.status!=='error';
    $('analysisResults').hidden=state.status!=='ready';$('analysisPanel').setAttribute('aria-busy',String(state.status==='loading'));
    if(state.status!=='ready')return;
    const r=state.result,t=r.tempo;
    $('analysisDuration').textContent=stamp(r.duration);
    $('analysisTempo').textContent=t.bpm?`${t.bpm} BPM（估计）`:'不明确';
    $('analysisConfidence').textContent=`脉冲周期稳定度 ${Math.round(t.confidence*100)}%（不是 BPM 正确概率）`;
    $('analysisReason').textContent=t.reason+(t.candidates.length?'；候选：'+t.candidates.map(c=>c.bpm+' BPM').join(' / '):'');
    $('analysisBeatCount').textContent=r.beats.times.length+' 个低频起音候选；不是已确认拍网格';
    $('analysisBeatTimes').textContent=r.beats.times.length?r.beats.times.map(stamp).join(' · '):'没有可靠起音候选';
    drawEnergy(r);$('analysisMoments').replaceChildren();
    const moments=r.candidates.length?r.candidates:[null];
    for(const m of moments){const li=document.createElement('li');li.textContent=m?`${stamp(m.time)}–${stamp(m.end)} · ${m.type==='energy-rise'?'明显能量上升（约 +'+m.deltaDb+' dB）':'较高能量区间'}`:'没有显著能量变化候选';$('analysisMoments').append(li);}
  }
  const controller=new BeatAnalysisController(run,state=>{render(state);window.dispatchEvent(new CustomEvent('beatvision:analysis',{detail:state}));});
  window.BeatAnalysis={request(file){lastFile=file;return controller.request(file);},cancel(){lastFile=null;controller.cancel();},get state(){return controller.state;},get result(){return controller.state.result||null;}};
  $('analysisCancel').addEventListener('click',()=>{window.BeatAnalysis.cancel();});
  // Retry uses the same import entry point, so a successful retry also loads the existing player.
  $('analysisRetry').addEventListener('click',()=>{if(lastFile)window.BeatVision.loadAudioFile(lastFile);});
  render(controller.state);
})();
