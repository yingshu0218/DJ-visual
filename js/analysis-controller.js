/* Latest-request-wins, with one active decoder and one replaceable pending file. */
(function(root){
  'use strict';
  class AnalysisController {
    constructor(run,onState){this.run=run;this.onState=onState;this.id=0;this.busy=false;this.pending=null;this.state={status:'idle',result:null};}
    emit(state){this.state=state;this.onState?.(state);}
    request(file){
      const id=++this.id;
      if(this.pending) this.pending.resolve(null);
      this.emit({status:'loading',id,name:file.name,result:null,progress:0,message:'等待本地分析…'});
      return new Promise(resolve=>{this.pending={id,file,resolve};this.drain();});
    }
    cancel(){++this.id;if(this.pending)this.pending.resolve(null);this.pending=null;this.emit({status:'idle',result:null,message:'已取消，可重新选择音频'});}
    async drain(){
      if(this.busy)return;this.busy=true;
      while(this.pending){
        const job=this.pending;this.pending=null;
        const current=()=>job.id===this.id;
        try{
          const result=await this.run(job.file,()=>!current(),(message,progress)=>{if(current())this.emit({status:'loading',id:job.id,name:job.file.name,result:null,message,progress});});
          if(current()){this.emit({status:'ready',id:job.id,name:job.file.name,result,progress:1});job.resolve(result);}else job.resolve(null);
        }catch(e){if(current())this.emit({status:'error',id:job.id,name:job.file.name,result:null,message:e.message||'分析失败，请重试或换一个文件'});job.resolve(null);}
      }
      this.busy=false;
    }
  }
  if(typeof module!=='undefined'&&module.exports)module.exports=AnalysisController;else root.BeatAnalysisController=AnalysisController;
})(typeof window!=='undefined'?window:globalThis);
