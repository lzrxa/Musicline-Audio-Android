/* V3.12.34: LAME MP3 CBR export from PCM WAV using streaming slice reads and OPFS. */
(function(global){
'use strict';
let lamePromise=null;
function getLame(){
 if(global.lamejs?.Mp3Encoder)return Promise.resolve(global.lamejs);
 if(lamePromise)return lamePromise;
 lamePromise=new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src='/vendor/lamejs-1.2.1/lame.min.js?v=v31234';
  script.onload=()=>global.lamejs?.Mp3Encoder?resolve(global.lamejs):reject(Error('本地 MP3 编码器未正确加载'));
  script.onerror=()=>reject(Error('本地 MP3 编码文件加载失败'));
  document.head.append(script);
 }).catch(err=>{lamePromise=null;throw err;});return lamePromise;
}
function four(view,p){let t='';for(let j=0;j<4;j++)t+=String.fromCharCode(view.getUint8(p+j));return t;}
async function getWavInfo(file){
 const ab=await file.slice(0,Math.min(file.size,262144)).arrayBuffer(),v=new DataView(ab);
 if(v.byteLength<44||four(v,0)!=='RIFF'||four(v,8)!=='WAVE')throw Error('MP3 导出需要 PCM WAV 输入');
 let fmt=null,data=null,offset=12;
 while(offset+8<=v.byteLength){const tag=four(v,offset),size=v.getUint32(offset+4,true),p=offset+8;
  if(tag==='fmt '&&p+16<=v.byteLength)fmt={code:v.getUint16(p,true),channels:v.getUint16(p+2,true),sampleRate:v.getUint32(p+4,true),bits:v.getUint16(p+14,true)};
  if(tag==='data'){data={offset:p,bytes:Math.min(size,file.size-p)};break;}
  offset=p+size+(size&1);
 }
 if(!fmt||!data||![1,2].includes(fmt.channels)||!((fmt.code===1&&fmt.bits===16)||(fmt.code===3&&fmt.bits===32)))throw Error('仅支持 PCM16 或 Float32 WAV');
 if(![32000,44100,48000].includes(fmt.sampleRate))throw Error('MP3 编码需要 32kHz、44.1kHz 或 48kHz PCM；当前为 '+fmt.sampleRate+' Hz，暂不进行不安全的重采样');
 if(data.bytes<fmt.channels*(fmt.bits/8))throw Error('WAV 没有可用音频');
 return {...fmt,...data,frameBytes:fmt.channels*(fmt.bits/8)};
}
function pcmToInt16(ab,fmt){
 const frames=Math.floor(ab.byteLength/fmt.frameBytes),view=new DataView(ab),out=Array.from({length:fmt.channels},()=>new Int16Array(frames));
 for(let i=0;i<frames;i++)for(let c=0;c<fmt.channels;c++){
  const pos=i*fmt.frameBytes+c*(fmt.bits/8);
  if(fmt.code===1)out[c][i]=view.getInt16(pos,true);
  else{const x=Math.max(-1,Math.min(1,view.getFloat32(pos,true)));out[c][i]=Math.round(x<0?x*32768:x*32767);}
 }
 return out;
}
async function fromWav(file,opt={}){
 const kbps=Number(opt.kbps)||192;if(![128,192,320].includes(kbps))throw Error('仅支持 128 / 192 / 320 kbps');
 if(!global.navigator?.storage?.getDirectory)throw Error('MP3 导出需要浏览器 OPFS 临时文件支持');
 const fmt=await getWavInfo(file),lame=await getLame(),folder=await navigator.storage.getDirectory();
 const name='mp3-134-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.mp3';
 const handle=await folder.getFileHandle(name,{create:true});let writer=null,finished=false,bytes=0;
 const cleanup=async()=>{try{if(writer&&!finished)await writer.abort()}catch(_){}try{await folder.removeEntry(name)}catch(_){}};
 try{
  writer=await handle.createWritable();const encoder=new lame.Mp3Encoder(fmt.channels,fmt.sampleRate,kbps);
  const framesTotal=Math.floor(fmt.bytes/fmt.frameBytes),framesPerChunk=1152*12;
  for(let frame=0;frame<framesTotal;frame+=framesPerChunk){
   if(opt.cancelled?.())throw Error('MP3 编码已取消');
   const frames=Math.min(framesPerChunk,framesTotal-frame);
   const start=fmt.offset+frame*fmt.frameBytes,end=start+frames*fmt.frameBytes;
   const pcm=pcmToInt16(await file.slice(start,end).arrayBuffer(),fmt);
   const encoded=fmt.channels===2?encoder.encodeBuffer(pcm[0],pcm[1]):encoder.encodeBuffer(pcm[0]);
   if(encoded?.length){const bounded=new Uint8Array(encoded);await writer.write(new Blob([bounded],{type:'application/octet-stream'}));bytes+=bounded.length;}
   opt.onProgress?.(Math.round((frame+frames)/framesTotal*99));
   if(frame%(framesPerChunk*8)===0)await new Promise(r=>setTimeout(r,0));
  }
  const tail=encoder.flush();if(tail?.length){const bounded=new Uint8Array(tail);await writer.write(new Blob([bounded],{type:'application/octet-stream'}));bytes+=bounded.length;}
  if(bytes<100)throw Error('MP3 编码没有生成有效数据');
  await writer.close();finished=true;const result=await handle.getFile();
  if(result.size!==bytes)throw Error('MP3 合并字节长度错误');
  opt.onProgress?.(100);
  return {file:result,kbps,cleanup};
 }catch(e){await cleanup();throw e;}
}
async function detectBitrate(file){
 // Match original 128/192/320 bitrate; use the first valid MPEG1 Layer3 frame.
 const b=new Uint8Array(await file.slice(0,65536).arrayBuffer());let offset=0;
 if(b.length>=10&&String.fromCharCode(...b.slice(0,3))==='ID3')offset=10+((b[6]&127)<<21)+((b[7]&127)<<14)+((b[8]&127)<<7)+(b[9]&127);
 const rates=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
 for(let p=offset;p+4<=b.length;p++){
  if(b[p]!==255||(b[p+1]&0xfe)!==0xfa)continue;
  const version=(b[p+1]>>3)&3,layer=(b[p+1]>>1)&3,index=(b[p+2]>>4)&15;
  if(version!==3||layer!==1)continue;
  const rate=rates[index];if(rate)return rate;
 }
 return null;
}
global.SongMP3134={fromWav,detectBitrate,getWavInfo};
})(window);
