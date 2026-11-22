/* v3.12.59 quality-first local pitch export. Official Signalsmith Stretch 1.3.2 WASM.
 * Bounded aligned decoder (existing SongEQ146.decoded), one persistent multi-channel worker,
 * continuous DSP across segments, OPFS PCM16 output. No fallback to the retired vocoder.
 */
(function(G){
'use strict';
function wavHeader(rate,ch,bytes){if(bytes>0xffffffff-36)throw Error('单个 WAV 文件不能超过4GB');const b=new ArrayBuffer(44),v=new DataView(b);const tag=(p,s)=>{for(let i=0;i<s.length;i++)v.setUint8(p+i,s.charCodeAt(i));};tag(0,'RIFF');v.setUint32(4,36+bytes,true);tag(8,'WAVE');tag(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,ch,true);v.setUint32(24,rate,true);v.setUint32(28,rate*ch*2,true);v.setUint16(32,ch*2,true);v.setUint16(34,16,true);tag(36,'data');v.setUint32(40,bytes,true);return b;}
function pcm16(ch){const n=ch[0].length,c=ch.length,b=new ArrayBuffer(n*c*2),v=new DataView(b);let p=0;for(let i=0;i<n;i++)for(let k=0;k<c;k++){const x=Math.max(-1,Math.min(1,ch[k][i]));if(!Number.isFinite(x))throw Error('移调输出异常');v.setInt16(p,Math.round(x<0?x*32768:x*32767),true);p+=2;}return b;}
function workerClient(){
 const w=new Worker('/songs115/pitch158worker.js?v=v31260');let next=0,dead=false;const waiting=new Map();
 function close(reason=Error('已取消')){if(dead)return;dead=true;w.terminate();for(const p of waiting.values())p.reject(reason);waiting.clear();}
 w.onmessage=e=>{const p=waiting.get(e.data.id);if(!p)return;waiting.delete(e.data.id);if(e.data.error)p.reject(Error(e.data.error));else p.resolve(e.data);};
 w.onerror=e=>close(Error(e.message||'移调 Worker 加载失败'));
 return {close,call(msg,transfer=[]){if(dead)return Promise.reject(Error('移调Worker已关闭'));return new Promise((resolve,reject)=>{const id=++next;waiting.set(id,{resolve,reject});try{w.postMessage({...msg,id},transfer);}catch(e){waiting.delete(id);reject(e);}});}};
}
async function run(file,st,opt={}){
 if(!Number.isInteger(st)||Math.abs(st)>12)throw Error('移调范围为-12至+12半音');
 if(!file?.size||file.size>150*1048576)throw Error('音频大小须在0至150MiB之间');
 if(!/\.(mp3|wav)$/i.test(file.name))throw Error('移调支持 MP3 和 PCM WAV；其他格式请先转换');
 const abort=()=>!!opt.cancelled?.();if(abort())throw Error('移调已取消');
 // Defence-in-depth: original-format 0-st UI bypass is retained; direct API also returns original bytes.
 if(st===0&&!opt.forceWav)return {file,segments:0,warnings:[],cleanup:async()=>{},original:true};
 if(!G.SongEQ146?.decoded)throw Error('分段解码模块未加载，请完整上传 v3.12.60 包');
 if(!navigator.storage?.getDirectory)throw Error('浏览器不支持OPFS临时文件');
 const folder=await navigator.storage.getDirectory(),temp='pitch133-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.wav';
 const handle=await folder.getFileHandle(temp,{create:true}),writer=await handle.createWritable();
 let ctx=null,client=null,poll=0,closed=false,bytes=0,samples=0,inputSamples=0,rate=0,channels=0,count=0,stats=null;
 const cleanup=async()=>{if(!closed)try{await writer.abort();}catch(_){}try{await folder.removeEntry(temp);}catch(_){}};
 try{
  ctx=new (G.AudioContext||G.webkitAudioContext)({sampleRate:44100});if(st!==0)client=workerClient();
  poll=setInterval(()=>{if(abort())client?.close(Error('移调已取消'));},40);
  await writer.write(new Uint8Array(44));
  const write=async(ch)=>{if(!ch[0].length)return;const pcm=pcm16(ch);if(bytes+pcm.byteLength>0xffffffff-36)throw Error('输出WAV不能超过4GB，请先分段');await writer.write(pcm);bytes+=pcm.byteLength;samples+=ch[0].length;};
  for await(const d of G.SongEQ146.decoded(file,ctx,abort)){
   if(abort())throw Error('移调已取消');count=d.count;
   if(!rate){rate=d.rate;channels=d.channels;if(st!==0)await client.call({cmd:'start',rate,channels,st,formant:opt.formant===true});}
   if(rate!==d.rate||channels!==d.channels)throw Error('音频中途改变采样率或声道数');inputSamples+=d.ch[0].length;
   opt.onProgress?.({segment:count,percent:Math.min(95,Math.round(d.percent*95)),stage:'相位锁定高精度移调'});
   // One decoded segment plus one processed segment at most; transfers avoid additional PCM copies.
   const out=st===0?{ch:d.ch}:await client.call({cmd:'push',ch:d.ch},d.ch.map(x=>x.buffer));if(abort())throw Error('移调已取消');await write(out.ch);
   await new Promise(r=>setTimeout(r,0));
  }
  if(!rate)throw Error('没有可解码的音频');const tail=st===0?{ch:Array.from({length:channels},()=>new Float32Array(0)),stats:{engine:'0st format conversion bypass',outputSamples:inputSamples,limited:0}}:await client.call({cmd:'finish'});stats=tail.stats;await write(tail.ch);
  if(abort())throw Error('移调已取消');if(samples!==inputSamples||stats.outputSamples!==inputSamples)throw Error('移调时长校验失败，未保留不完整结果');
  await writer.seek(0);await writer.write(wavHeader(rate,channels,bytes));await writer.truncate(44+bytes);await writer.close();closed=true;
  const output=await handle.getFile();if(output.size!==44+bytes)throw Error('输出WAV长度异常');
  opt.onProgress?.({segment:count,percent:100,stage:'完成'});
  const warnings=[];if(stats.limited)warnings.push('提升后的少量峰值经过安全软限幅，请试听确认');
  return {file:output,segments:count,seconds:samples/rate,warnings,stats,cleanup};
 }catch(e){await cleanup();throw e;}finally{clearInterval(poll);client?.close();if(ctx)try{await ctx.close();}catch(_){}}
}
G.SongPitch133={run,workerClient,engine:'IPL Phase Vocoder + Formant 3.12.60',version:'3.12.60'};
})(typeof window!=='undefined'?window:globalThis);
