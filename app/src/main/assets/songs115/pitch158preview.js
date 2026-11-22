/* v3.12.59: bounded excerpt preview; same Signalsmith WASM/default settings as full export.
 * No playbackRate; short bounded decode; latest request wins; worker is terminated on cancel.
 */
(function(G){
'use strict';
function controller(load,render,apply,notify){
 let generation=0,active=null,disposed=false;
 function cancel(){generation++;if(active){active.dead=true;active.abort?.();active=null;}}
 return {cancel,dispose(){disposed=true;cancel();},async request(spec){
  cancel();if(disposed)return;const id=generation,job={dead:false,abort:null};active=job;
  const valid=()=>!disposed&&!job.dead&&generation===id;
  try{notify?.('loading');const input=await load(spec,job);if(!valid())return;
   const output=await render(input,spec,job);if(!valid())return;
   apply(output,input,spec);notify?.('done');
  }catch(e){if(valid())notify?.('error',e);}finally{if(active===job)active=null;}
 }};
}
async function excerpt(file,position,job){
 if(!file||!file.size||file.size>150*1048576)throw Error('请选择 0 至 150MiB 的 MP3 / PCM WAV');
 const C=G.SongChunk126,mp3=/\.mp3$/i.test(file.name),wav=/\.wav$/i.test(file.name);
 if(!mp3&&!wav)throw Error('试听支持 MP3 / PCM WAV；其他格式请先转换');
 const signal={get aborted(){return job.dead;}};
 // Existing chunk infrastructure scans metadata/frame indexes, but only selected 12s core (+1s context each side) is decoded.
 const it=mp3?C.mp3Segments(file,signal,{core:12,lead:1,trail:1}):C.wavSegments(file,signal,{core:12,lead:1,trail:1});
 for await(const seg of it){
  if(job.dead)throw Error('已取消');
  if(position>=seg.endSeconds&&!seg.last)continue;
  const ctx=new (G.AudioContext||G.webkitAudioContext)({sampleRate:44100});
  job.abort=()=>{ctx.close().catch(()=>{});};
  try{
   const audio=await ctx.decodeAudioData(await seg.blob.arrayBuffer());if(job.dead)throw Error('已取消');
   const rate=audio.sampleRate,at=Math.max(seg.startSeconds,Math.min(position,Math.max(seg.startSeconds,seg.endSeconds-(position>=seg.endSeconds?8:0.1))));
   const first=Math.round(((seg.leadingSeconds||0)+at-seg.startSeconds)*rate);
   const frames=Math.min(Math.round(8*rate),audio.length-first,Math.round((seg.endSeconds-at)*rate));
   if(frames<rate*0.08)throw Error('此位置太接近结尾，请向前移动试听位置');
   const ch=Array.from({length:Math.min(2,audio.numberOfChannels)},(_,c)=>audio.getChannelData(c).slice(first,first+frames));
   return {ch,rate,position:at,seconds:frames/rate};
  }finally{job.abort=null;await ctx.close().catch(()=>{});}
 }
 throw Error('没有可试听片段');
}
function render(input,spec,job){
 return new Promise((resolve,reject)=>{
  const worker=new Worker('/songs115/pitch158worker.js?v=v31260');
  const stop=()=>{worker.terminate();job.abort=null;};
  job.abort=()=>{stop();reject(Error('已取消'));};
  worker.onmessage=e=>{stop();if(e.data.error)reject(Error(e.data.error));else resolve(e.data);};
  worker.onerror=e=>{stop();reject(Error(e.message||'试听计算失败'));};
  // clone rather than transfer original: A/B retains exact dry PCM.
  worker.postMessage({ch:input.ch,rate:input.rate,st:spec.st,formant:spec.formant});
 });
}
let mounted=null;
function cancel(){mounted?.cancel();}
function mount(opt){
 mounted?.destroy();
 const box=document.createElement('div');box.className='song149-live';box.innerHTML=`<b>独立相位锁定高精度移调 · 片段试听</b><p class="sub">先算最多 8 秒片段，不必等整首。更改半音后自动刷新，有短暂计算等待；不是连续零延迟移调。试听与整曲导出使用同一引擎、同一质量设置；大幅移调仍可能不自然。</p><label class="field">试听位置（秒，可选人声开始处）<input type="number" min="0" step="1" value="30" aria-label="试听位置（秒）"></label><label class="song146-dyn"><input type="checkbox" data-formant checked><span><b>保留人声音色（共振峰补偿）</b><small>默认开启，采用谱包络共振峰校正减少人声发尖/变粗；纯器乐大跨度移调也可按需关闭。试听与导出同步使用此设置。</small></span></label><div class="btns"><button type="button" class="btn-mint" data-preview>试听此片段</button><button type="button" class="ghost" data-stop>停止 / 取消</button><button type="button" class="ghost" data-ab disabled>听原调对比</button></div><p role="status" class="sub" data-note>请选择音频，设置试听位置后点试听。短音频会自动使用结尾附近的位置。</p>`;
 opt.host.after(box);
 const $=s=>box.querySelector(s),note=$('[data-note]'),ab=$('[data-ab]'),pos=$('input');
 let timer=0,ctx=null,source=null,gain=null,buffers=null,started=0,offset=0,dry=false,closed=false,observer;
 const voices=new Set();
 let cached=null;
 function stopAudio(keepContext=false){
  const c=ctx,now=c?.currentTime||0;
  for(const v of voices){try{const g=v.previewGain?.gain;if(g){g.cancelScheduledValues(now);g.setValueAtTime(g.value,now);g.linearRampToValueAtTime(0,now+.012);}v.stop(now+.013);}catch(_){try{v.stop();}catch(_){}}}
  voices.clear();source=null;gain=null;
  if(c&&keepContext!==true){ctx=null;setTimeout(()=>c.close().catch(()=>{}),20);}
  buffers=null;ab.disabled=true;
 }
 function ensureContext(){if(!ctx||ctx.state==='closed')ctx=new (G.AudioContext||G.webkitAudioContext)({sampleRate:44100});ctx.resume().catch(()=>{});return ctx;}
 function play(at=0){
  if(!buffers||!ctx)return;
  const c=ctx,previous=source,previousGain=gain,now=c.currentTime;
  source=c.createBufferSource();source.buffer=buffers[dry?0:1];gain=c.createGain();
  source.previewGain=gain;source.connect(gain);gain.connect(c.destination);source.loop=true;
  const span=source.buffer.duration;offset=at%span;started=now;
  // Preview playback only: edge window is an AudioParam envelope, PCM remains unmodified.
  const fade=Math.min(.012,span/8),g=gain.gain;g.setValueAtTime(0,now);g.linearRampToValueAtTime(1,now+fade);
  // Loop boundary envelope (finite 60s preview session) prevents wrap discontinuities without touching DSP PCM.
  let boundary=now+span-offset;
  for(let k=0;k<Math.ceil(60/span)+2;k++,boundary+=span){if(boundary-now<fade)continue;g.setValueAtTime(1,boundary-fade);g.linearRampToValueAtTime(0,boundary);g.linearRampToValueAtTime(1,boundary+fade);}
  g.cancelScheduledValues(now+60-fade);g.setValueAtTime(1,now+60-fade);g.linearRampToValueAtTime(0,now+60);
  source.start(now,offset);source.stop(now+60);const voice=source;voices.add(voice);voice.onended=()=>{voices.delete(voice);voice.disconnect();if(source===voice){source=null;note.textContent='试听已结束，点“试听此片段”可继续。';}};
  if(previous){previousGain.gain.cancelScheduledValues(now);previousGain.gain.setValueAtTime(previousGain.gain.value,now);previousGain.gain.linearRampToValueAtTime(0,now+.012);try{previous.stop(now+.013);}catch(_){}}
 }
 const ctl=controller(async(spec,job)=>{
  if(cached&&cached.file===spec.file&&cached.position===spec.position)return cached.input;
  const input=await excerpt(spec.file,spec.position,job);
  if(!job.dead)cached={file:spec.file,position:spec.position,input};return input;
 },render,(output,input,spec)=>{
  if(closed||!box.isConnected)return;
  const c=ensureContext();buffers=[input.ch,output.ch].map(ch=>{const b=c.createBuffer(ch.length,ch[0].length,input.rate);ch.forEach((x,i)=>b.copyToChannel(x,i));return b;});
  dry=false;ab.disabled=false;ab.textContent='听原调对比';play();
  note.textContent=`已试听 ${input.position.toFixed(1)} 秒起的 ${input.seconds.toFixed(1)} 秒片段 · ${spec.st===0?'原调':spec.st+' 半音'} · 新引擎计算 ${Math.round(output.ms)} ms。循环试听最多 60 秒，可比较或导出整曲。`;
 },(state,e)=>{box.setAttribute('aria-busy',String(state==='loading'));if(state==='loading')note.textContent='正在读取片段并用独立相位锁定引擎计算，请稍候…';if(state==='error'){stopAudio();note.textContent='无法试听：'+(e.message||e)+'。请刷新页面或重新选择音频再试。';}});
 function cancelLocal(keepContext=false){clearTimeout(timer);ctl.cancel();stopAudio(keepContext===true);box.setAttribute('aria-busy','false');}
 function request(){clearTimeout(timer);if(closed)return;const file=opt.getFile();if(!file){note.textContent='请先选择音频文件';return;}
  // Resume synchronously during click/change gesture, before asynchronous decoding / worker work (Safari).
  cancelLocal(true);opt.onPreview?.();ensureContext();ctl.request({file,st:Number(opt.select.value),position:Math.max(0,Number(pos.value)||0),formant:$('[data-formant]').checked});
 }
 function changed(){cancelLocal();if(!opt.getFile())return;note.textContent='参数已变化，正在准备刷新试听…';ensureContext();timer=setTimeout(request,250);}
 function fileChanged(){cached=null;cancelLocal();note.textContent='已更换音频，请选择试听位置后点试听。';}
 const handlers=[[$('[data-preview]'),'click',request],[$('[data-stop]'),'click',()=>{cancelLocal();note.textContent='已停止试听 / 取消计算。';}],[ab,'click',()=>{if(!buffers)return;const at=source?(offset+ctx.currentTime-started)%buffers[0].duration:0;dry=!dry;ab.textContent=dry?'听移调效果':'听原调对比';play(at);}],[$('[data-formant]'),'change',changed],[opt.select,'change',changed],[pos,'change',changed],[opt.fileInput,'change',fileChanged],[opt.exportButton,'click',cancelLocal]];
 handlers.forEach(([el,type,fn])=>el?.addEventListener(type,fn));
 function destroy(){if(closed)return;closed=true;cached=null;cancelLocal();ctl.dispose();observer?.disconnect();handlers.forEach(([el,type,fn])=>el?.removeEventListener(type,fn));box.remove();if(mounted===api)mounted=null;opt.onDispose?.();}
 observer=new MutationObserver(()=>{if(!box.isConnected)destroy();});observer.observe(document.body,{childList:true,subtree:true});
 const api={cancel:cancelLocal,destroy,formant:()=>$('[data-formant]').checked};mounted=api;
}
G.SongPitchPreview158={mount,cancel,controller,excerpt,getSettings:()=>({formant:mounted?.formant?.()===true})};
})(typeof window!=='undefined'?window:globalThis);
