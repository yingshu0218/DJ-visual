/* Pure offline analysis. All times derive from PCM sample indices, never animation frames. */
(function (root) {
  'use strict';
  const VERSION = '1.0.0';
  const LIMITS = { maxDuration: 600, maxBytes: 48 * 1024 * 1024, sampleRate: 11025 };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const median = a => { const b = a.slice().sort((x,y)=>x-y); return b.length ? b[b.length>>1] : 0; };
  const round = x => Math.round(x * 1000) / 1000;
  async function analyze(channels, sampleRate, options = {}) {
    if (!channels.length || !Number.isFinite(sampleRate) || sampleRate < 1000) throw new Error('无效的音频采样数据');
    const length = channels[0].length, duration = length / sampleRate;
    if (!length || channels.some(c=>c.length !== length)) throw new Error('音频没有可分析的采样');
    if (duration > LIMITS.maxDuration + 0.01) throw new Error('本阶段支持最长 10 分钟音频，请选择较短的文件');
    const check = () => { if (options.cancelled?.()) { const e = new Error('分析已取消'); e.name = 'AbortError'; throw e; } };
    const yieldTask = options.yieldTask || (() => new Promise(r => setTimeout(r, 0)));
    // Non-overlapping 10ms windows. Channel powers are averaged (anti-phase stereo cannot cancel).
    const hop = Math.max(1, Math.round(sampleRate * 0.01));
    const rms = [], low = [], binSeconds = Math.max(0.5, duration / 600);
    const bins = Array.from({length:Math.ceil(duration/binSeconds)}, (_,i)=>({start:round(i*binSeconds),end:round(Math.min(duration,(i+1)*binSeconds)),sum:0,count:0}));
    const filter = channels.map(()=>0); const alpha = 1-Math.exp(-2*Math.PI*180/sampleRate);
    let total=0, peak=0;
    for(let start=0, frame=0;start<length;start+=hop,frame++) {
      check(); let sq=0, ls=0; const end=Math.min(length,start+hop);
      for(let i=start;i<end;i++) {
        let p=0,l=0;
        for(let c=0;c<channels.length;c++) { const x=Number.isFinite(channels[c][i])?channels[c][i]:0; p+=x*x; filter[c]+=alpha*(x-filter[c]); l+=filter[c]*filter[c]; peak=Math.max(peak,Math.abs(x)); }
        p/=channels.length; l/=channels.length; sq+=p; ls+=l;
        const b=bins[Math.min(bins.length-1,Math.floor(i/sampleRate/binSeconds))];b.sum+=p;b.count++;
      }
      total+=sq; rms.push(Math.sqrt(sq/(end-start)));low.push(Math.sqrt(ls/(end-start)));
      if(frame%200===0) { options.progress?.(Math.min(0.8,end/length*0.8)); await yieldTask(); }
    }
    check(); const overall=Math.sqrt(total/length);const silent=overall<0.0001;
    const energy=bins.map(b=>({start:b.start,end:b.end,rms:round(Math.sqrt(b.sum/Math.max(1,b.count))),dbFS:round(20*Math.log10(Math.max(1e-6,Math.sqrt(b.sum/Math.max(1,b.count)))))}));
    const onset=low.map((x,i)=>i?Math.max(0,x-low[i-1]):0); const maxOn=Math.max(0,...onset);
    const peaks=[]; let last=-999;
    if(!silent) for(let i=2;i<onset.length-2;i++) {
      if(i%2000===0) { await yieldTask(); check(); }
      const local=onset.slice(Math.max(0,i-50),Math.min(onset.length,i+51));
      const threshold=Math.max(0.001,maxOn*0.12,median(local)*3);
      if(onset[i]>threshold && onset[i]>=onset[i-1] && onset[i]>onset[i+1]) {
        const time=i*hop/sampleRate;
        if(time-last>=0.22) { peaks.push({time:round(time),strength:onset[i]/maxOn});last=time; }
        else if(peaks.length && onset[i]/maxOn>peaks[peaks.length-1].strength) {peaks[peaks.length-1]={time:round(time),strength:onset[i]/maxOn};last=time;}
      }
    }
    options.progress?.(0.85);await yieldTask();check();
    const gaps=peaks.slice(1).map((p,i)=>p.time-peaks[i].time);const typical=median(gaps);
    const regular=gaps.length?gaps.filter(g=>Math.abs(g-typical)<typical*0.12).length/gaps.length:0;
    const warnings=[];let bpm=null, confidence=0, status='unclear', reason='没有足够稳定的低频起音，无法可靠估计速度';let candidates=[];
    if(silent) {status='silent';reason='音轨接近静音';}
    else if(duration<4) {status='too-short';reason='音轨少于 4 秒，节奏证据不足';}
    else if(peaks.length>=8 && regular>=0.72 && typical>0) {
      const observed=60/typical;
      candidates=[observed/2,observed,observed*2].filter(x=>x>=45&&x<=210).map(x=>({bpm:Math.round(x*10)/10,relation:Math.abs(x-observed)<0.1?'observed-pulse':x<observed?'half-time':'double-time'}));
      confidence=round(clamp(regular*Math.min(1,gaps.length/24),0,0.95));
      // A pulse train alone cannot decide musical metrical level. Do not pick an octave by convention.
      if(candidates.length>1){status='ambiguous';reason='存在半速／倍速歧义；检测到的低频脉冲不等于已确认的音乐拍速';}
      else if(confidence>=0.7){bpm=candidates[0].bpm;status='estimated';reason='稳定低频脉冲估计，仍需人工听感确认';}
    }
    if(status!=='estimated') warnings.push(reason);
    const sortedEnergy=energy.map(b=>b.dbFS).sort((a,b)=>a-b);const high=sortedEnergy[Math.floor(sortedEnergy.length*0.8)]??-120;
    const moments=[];
    if(!silent) for(let i=2;i<energy.length;i++) {
      const b=energy[i], prior=(energy[i-1].dbFS+energy[i-2].dbFS)/2;
      if(b.dbFS>-40 && b.dbFS-prior>=6 && (!moments.length || b.start-moments[moments.length-1].time>=4)) moments.push({time:b.start,end:b.end,type:'energy-rise',deltaDb:round(b.dbFS-prior)});
    }
    const highEnergy=[];if(!silent && (sortedEnergy.at(-1)-sortedEnergy[0])>=3) for(const b of energy) {
      if(b.dbFS>=high && b.dbFS>-40) {const prev=highEnergy.at(-1);if(prev&&Math.abs(prev.end-b.start)<0.01) prev.end=b.end;else highEnergy.push({time:b.start,end:b.end,type:'high-energy'});}
    }
    check();options.progress?.(1);
    return {schemaVersion:1,algorithmVersion:VERSION,timeUnit:'seconds',duration:round(duration),sampleRate,channels:channels.length,
      tempo:{bpm,status,confidence,confidenceMeaning:'低频脉冲周期稳定度；不是 BPM 正确概率',reason,candidates},
      beats:{kind:'detected-low-frequency-onsets',confirmedGrid:false,toleranceSeconds:round(hop/sampleRate),times:peaks.map(p=>p.time)},
      energy:{binSeconds:round(binSeconds),unit:'dBFS',bins:energy},candidates: [...moments,...highEnergy].sort((a,b)=>a.time-b.time).slice(0,100),
      warnings,summary:{silent,rms:round(overall),peak:round(peak)},limits:{...LIMITS}};
  }
  const api={analyze,LIMITS,VERSION};if(typeof module!=='undefined'&&module.exports) module.exports=api;else root.BeatAnalysisCore=api;
})(typeof window!=='undefined'?window:globalThis);
