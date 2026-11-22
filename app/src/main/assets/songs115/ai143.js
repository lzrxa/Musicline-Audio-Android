/* V3.12.44 multi-model pipelines (page thread, same runtime as V3.12.42).
   - Multi-model ensemble: run each model over the whole song, then average the waveforms (UVR "Avg Wave").
   - Two-stage karaoke: stage 1 extracts all vocals; stage 2 splits the vocal stem into lead and backing.
   The separator is created by the caller (makeSeparator), so this file does not load any AI engine.
   All long outputs are PCM16 WAV in OPFS, compatible with history / pitch / MP3 export. */
(function(global){
 'use strict';
 const OUT_RATE=44100,HDR=44;
 const tick=()=>new Promise(r=>setTimeout(r,0));
 const alive=s=>{if(s?.aborted)throw Error('分离任务已取消');};
 // ---------- streaming WAV mixing in OPFS ----------
 function wavHeader(rate,ch,len){const b=new ArrayBuffer(HDR),v=new DataView(b),w=(p,t)=>{for(let i=0;i<4;i++)v.setUint8(p+i,t.charCodeAt(i));};w(0,'RIFF');v.setUint32(4,36+len,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,ch,true);v.setUint32(24,rate,true);v.setUint32(28,rate*ch*2,true);v.setUint16(32,ch*2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,len,true);return b;}
 function limit(x){const a=x<0?-x:x;if(a<=0.9)return x;const y=0.9+0.1*Math.tanh((a-0.9)/0.1);return x<0?-y:y;}
 async function mixWav(files,weights,name,signal){
  const dir=await navigator.storage.getDirectory();
  let bytes=Math.min(...files.map(f=>f.size))-HDR;bytes-=bytes%4;if(bytes<=0)throw Error('待合并音轨为空');
  const diff=Math.max(...files.map(f=>f.size))-Math.min(...files.map(f=>f.size));
  const h=await dir.getFileHandle(name,{create:true}),w=await h.createWritable();
  try{
   await w.write(new Blob([wavHeader(OUT_RATE,2,bytes)]));
   const CH=1<<20;let n=0;
   for(let p=0;p<bytes;p+=CH){
    alive(signal);const e=Math.min(bytes,p+CH);
    const arrs=await Promise.all(files.map(f=>f.slice(HDR+p,HDR+e).arrayBuffer().then(b=>new Int16Array(b))));
    const out=new Int16Array(arrs[0].length);
    for(let i=0;i<out.length;i++){let v=0;for(let k=0;k<arrs.length;k++)v+=arrs[k][i]*weights[k];v=limit(v/32768);out[i]=Math.round(v<0?v*32768:v*32767);}
    await w.write(new Blob([out.buffer]));if((++n&7)===0)await tick();
   }
   await w.close();
   const f=await h.getFile();if(f.size!==HDR+bytes)throw Error('合并音轨大小校验失败');
   return {file:f,lengthDiffBytes:diff};
  }catch(e){try{await w.abort();}catch(_){}try{await dir.removeEntry(name);}catch(_){}throw e;}
 }
 const rid=()=>'ai143-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
 async function removeAll(names){try{const d=await navigator.storage.getDirectory();for(const n of names)try{await d.removeEntry(n);}catch(_){}}catch(_){}}
 // One or several models over the whole song. Several = waveform average (UVR "Avg Wave").
 // makeSeparator(model) must return a fresh separator; it is disposed after its pass so only one
 // model is in memory at a time (important on phones).
 async function runModels(file,models,{makeSeparator,signal,onProgress,denoise}){
  const C=global.SongChunk126;if(!C?.run)throw Error('分段核心未初始化');
  const passes=[];
  try{
   for(let k=0;k<models.length;k++){
    alive(signal);onProgress?.({stage:'load',pass:k+1,passes:models.length,model:models[k]});
    const sep=await makeSeparator(models[k],k);
    try{passes.push(await C.run(file,sep,{signal,denoise,onProgress:e=>onProgress?.({...e,pass:k+1,passes:models.length,model:models[k],sep})}));}
    finally{try{sep.dispose?.();}catch(_){}}
    await tick();
   }
   if(passes.length===1)return passes[0];
   onProgress?.({stage:'merge',pass:models.length,passes:models.length});
   const id=rid(),w=models.map(()=>1/models.length);
   const inst=await mixWav(passes.map(p=>p.files[0]),w,id+'-instrumental.wav',signal);
   const voc=await mixWav(passes.map(p=>p.files[1]),w,id+'-vocals.wav',signal);
   const warnings=[];for(const p of passes)warnings.push(...(p.warnings||[]));
   if(inst.lengthDiffBytes>4*OUT_RATE*0.05)warnings.push('各模型输出长度相差 '+(inst.lengthDiffBytes/4/OUT_RATE).toFixed(2)+' 秒，已按最短长度合并。');
   for(const p of passes)await p.cleanup?.();
   const names=[id+'-instrumental.wav',id+'-vocals.wav'];
   return {files:[inst.file,voc.file],segments:passes[0].segments,duration:passes[0].duration,warnings:[...new Set(warnings)],stats:passes[0].stats,ensemble:models.length,cleanup:()=>removeAll(names)};
  }catch(e){for(const p of passes)try{await p.cleanup?.();}catch(_){}throw e;}
 }
 // Two-stage karaoke: stage 1 extracts all vocals; stage 2 runs the Karaoke model on the vocal stem only,
 // splitting it into lead and backing vocals. Karaoke track = instrumental + backing vocals.
 async function karaoke2(file,{stage1Models,karaModel='UVR_MDXNET_KARA_2',makeSeparator,signal,onProgress,denoise}){
  const s1=await runModels(file,stage1Models,{makeSeparator,signal,denoise,onProgress:e=>onProgress?.({...e,stage1:true})});
  let s2=null;
  try{
   alive(signal);
   s2=await runModels(s1.files[1],[karaModel],{makeSeparator,signal,denoise,onProgress:e=>onProgress?.({...e,stage2:true})});
   // KARA_2 primary stem is "Instrumental" = everything except the lead vocal = backing vocals here.
   onProgress?.({stage:'merge',stage2:true});
   const id=rid();
   const kar=await mixWav([s1.files[0],s2.files[0]],[1,1],id+'-karaoke.wav',signal);
   const warnings=[...new Set([...(s1.warnings||[]),...(s2.warnings||[])])];
   return {tracks:{instrumental:s1.files[0],vocals:s1.files[1],lead:s2.files[1],backing:s2.files[0],karaoke:kar.file},segments:s1.segments,duration:s1.duration,warnings,stats:s1.stats,
    cleanup:async()=>{await s1.cleanup?.();await s2.cleanup?.();await removeAll([id+'-karaoke.wav']);}};
  }catch(e){try{await s1.cleanup?.();}catch(_){}try{await s2?.cleanup?.();}catch(_){}throw e;}
 }
 global.SongAI143={runModels,karaoke2,mixWav,version:'3.12.44'};
})(window);
