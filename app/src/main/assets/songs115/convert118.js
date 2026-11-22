/* Browser-local video-to-audio export. Video stays on the device; only the exported audio may be uploaded. */
(function(global){
  const VIDEO_EXT=/\.(mp4|mov|m4v|webm)$/i;
  const LAME_SRC='/vendor/lamejs-1.2.1/lame.min.js?v=v31220a';
  const MP3_RATES=[192,320];
  const LAME_RATES=[8000,11025,12000,16000,22050,24000,32000,44100,48000];
  let lameReady=null;

  const basename=name=>String(name||'').replace(VIDEO_EXT,'');
  const clamp16=s=>s<0?Math.max(-1,s)*0x8000:Math.min(1,s)*0x7fff;
  const yieldUI=()=>new Promise(r=>setTimeout(r,0));
  function aborted(signal){if(signal?.aborted){const e=Error('已取消转换，未上传任何文件');e.code='cancelled';throw e;}}
  function loadLame(){
    if(global.lamejs?.Mp3Encoder)return Promise.resolve(global.lamejs);
    if(lameReady)return lameReady;
    lameReady=new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.src=LAME_SRC;
      s.async=true;
      s.onload=()=>global.lamejs?.Mp3Encoder?resolve(global.lamejs):reject(Error('MP3编码器未正确加载'));
      s.onerror=()=>{lameReady=null;reject(Error('MP3编码器加载失败。请检查网络后重试，或改用 WAV。'));};
      document.head.append(s);
    }).catch(err=>{lameReady=null;throw err;});
    return lameReady;
  }

  function mediaDuration(file,signal){
    return new Promise((resolve,reject)=>{
      const el=document.createElement('video');
      el.preload='metadata';
      el.muted=true;
      el.playsInline=true;
      const url=URL.createObjectURL(file);
      const finish=fn=>{URL.revokeObjectURL(url);el.removeAttribute('src');try{el.load();}catch(_){ }el.remove();fn();};
      const onAbort=()=>finish(()=>reject(Object.assign(Error('已取消转换，未上传任何文件'),{code:'cancelled'})));
      signal?.addEventListener('abort',onAbort,{once:true});
      el.onloadedmetadata=()=>{const d=el.duration;finish(()=>{signal?.removeEventListener('abort',onAbort);if(!isFinite(d)||d<=0)reject(Error('无法读取视频时长，请换一个文件或改用 Safari / 电脑浏览器'));else resolve(d);});};
      el.onerror=()=>finish(()=>{signal?.removeEventListener('abort',onAbort);reject(Error('当前浏览器无法打开该视频。请确认是常见的 mp4 / mov / m4v / webm，且音轨可被本机解码。微信内置浏览器可能内存不足或受限，建议改用 Safari 或电脑上的 Chrome / Edge。'));});
      el.src=url;
    });
  }

  function estimateWavBytes(duration,sampleRate=48000,channels=2){
    return 44+Math.ceil(Math.max(0,duration)*sampleRate*channels*2);
  }
  function estimateMp3Bytes(duration,kbps){
    return Math.ceil(Math.max(0,duration)*(kbps*1000)/8)+1024;
  }
  function formatBytes(n){
    if(n<1000)return n+' 字节';
    if(n<1000000)return (n/1000).toFixed(n<10000?1:0)+' KB';
    return (n/1000000).toFixed(2)+' MB';
  }

  async function inspect(file,opts={}){
    if(!file)throw Error('请选择视频文件');
    const ext=String(file.name||'').split('.').pop().toLowerCase();
    if(!['mp4','mov','m4v','webm'].includes(ext))throw Error('仅支持 mp4、mov、m4v、webm。其他格式不会被转换。');
    if(!file.size)throw Error('文件为空');
    const duration=await mediaDuration(file,opts.signal);
    const wav=estimateWavBytes(duration),mp3_192=estimateMp3Bytes(duration,192),mp3_320=estimateMp3Bytes(duration,320);
    return {name:file.name,title:basename(file.name)||file.name,duration,estimated:{wav,mp3_192,mp3_320,sampleRate:'按 48 kHz 立体声预估，实际以导出为准'},label:`约 ${duration.toFixed(1)} 秒；WAV 约 ${formatBytes(wav)}，MP3 192 kbps 约 ${formatBytes(mp3_192)}，MP3 320 kbps 约 ${formatBytes(mp3_320)}`};
  }

  function toInt16(buffer){
    const channels=Math.min(2,buffer.numberOfChannels||1), length=buffer.length;
    const outs=Array.from({length:channels},()=>new Int16Array(length));
    if(buffer.numberOfChannels<=2){
      for(let c=0;c<channels;c++){
        const src=buffer.getChannelData(c), dst=outs[c];
        for(let i=0;i<length;i++)dst[i]=clamp16(src[i]);
      }
    }else{
      const chans=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
      for(let i=0;i<length;i++){
        let l=0,r=0;
        for(let c=0;c<chans.length;c++){const v=chans[c][i];if(c%2===0)l+=v;else r+=v;}
        const ln=Math.ceil(chans.length/2), rn=Math.floor(chans.length/2)||1;
        outs[0][i]=clamp16(l/ln);outs[1][i]=clamp16(r/rn);
      }
    }
    return {channels,length,sampleRate:buffer.sampleRate,pcm:outs};
  }

  function writeWav(pcm,sampleRate,onProgress,signal){
    const channels=pcm.length, length=pcm[0].length, dataSize=length*channels*2;
    const bytes=new Uint8Array(44+dataSize), view=new DataView(bytes.buffer);
    const tag=(o,s)=>{for(let i=0;i<s.length;i++)bytes[o+i]=s.charCodeAt(i);};
    tag(0,'RIFF');view.setUint32(4,36+dataSize,true);tag(8,'WAVE');tag(12,'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);
    view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*channels*2,true);
    view.setUint16(32,channels*2,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,dataSize,true);
    let o=44;
    for(let i=0;i<length;i++){
      for(let c=0;c<channels;c++,o+=2)view.setInt16(o,pcm[c][i],true);
      if((i&8191)===8191){aborted(signal);onProgress?.(0.4+0.55*(i/length));}
    }
    return bytes;
  }

  async function writeMp3(lame,pcm,sampleRate,kbps,onProgress,signal){
    if(!MP3_RATES.includes(kbps))throw Error('MP3 仅支持 192 或 320 kbps');
    const channels=pcm.length, length=pcm[0].length;
    const encoder=new lame.Mp3Encoder(channels,sampleRate,kbps);
    const block=1152, parts=[];
    for(let i=0;i<length;i+=block){
      aborted(signal);
      const L=pcm[0].subarray(i,i+block);
      const buf=channels>1?encoder.encodeBuffer(L,pcm[1].subarray(i,i+block)):encoder.encodeBuffer(L);
      if(buf.length)parts.push(buf);
      if((i/block%8)===0){onProgress?.(0.4+0.55*(i/length));await yieldUI();}
    }
    const last=encoder.flush();if(last.length)parts.push(last);
    let total=0;for(const p of parts)total+=p.length;
    const out=new Uint8Array(total);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}
    return out;
  }

  function parseMp3Frames(bytes,limit=40){
    const table=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
    const rates=[[11025,12000,8000],[0,0,0],[22050,24000,16000],[44100,48000,32000]];
    const frames=[];let i=0,guard=0;
    while(i+4<bytes.length && frames.length<limit && guard++<bytes.length){
      if(bytes[i]===0xFF && (bytes[i+1]&0xE0)===0xE0){
        const b1=bytes[i+1],b2=bytes[i+2];
        const ver=(b1>>3)&3, layer=(b1>>1)&3, brIdx=b2>>4, srIdx=(b2>>2)&3, pad=(b2>>1)&1;
        const bitrate=table[brIdx]*1000, sr=(rates[ver]||[])[srIdx]||0;
        if(ver!==3||layer!==1||!bitrate||!sr){i++;continue;}
        const frameLen=Math.floor(144*bitrate/sr)+pad;
        frames.push({bitrate,sampleRate:sr,frameLen});
        i+=frameLen||1;
      }else i++;
    }
    return frames;
  }

  function verify(bytes,format,kbps,sampleRate,channels){
    if(format==='wav'){
      const t=(o,n)=>String.fromCharCode(...bytes.slice(o,o+n));
      if(bytes.length<44||t(0,4)!=='RIFF'||t(8,4)!=='WAVE'||t(12,4)!=='fmt ')throw Error('导出的 WAV 无效，未加入上传');
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      if(view.getUint16(20,true)!==1||view.getUint16(34,true)!==16)throw Error('仅支持 16-bit PCM WAV');
      if(view.getUint16(22,true)!==channels||view.getUint32(24,true)!==sampleRate)throw Error('WAV 采样参数与导出声明不一致');
      if(t(36,4)!=='data')throw Error('WAV 数据块无效');
      return {format:'wav',bitrate:null,sampleRate,channels,label:`WAV · PCM 16-bit · ${(sampleRate/1000).toFixed(1)} kHz · ${channels===1?'单声道':'立体声'}`};
    }
    const frames=parseMp3Frames(bytes);
    if(!frames.length)throw Error('导出的 MP3 无法解析，未加入上传');
    const unique=[...new Set(frames.map(f=>f.bitrate))];
    if(unique.length!==1||unique[0]!==kbps*1000)throw Error(`MP3 实际码率与所选 ${kbps} kbps 不符，未加入上传`);
    return {format:'mp3',bitrate:kbps,sampleRate:frames[0].sampleRate||sampleRate,channels,label:`MP3 CBR ${kbps} kbps · ${((frames[0].sampleRate||sampleRate)/1000).toFixed(1)} kHz · ${channels===1?'单声道':'立体声'}`};
  }

  async function decode(file,signal,onProgress){
    aborted(signal);
    onProgress?.(0.08);
    const Ctor=global.AudioContext||global.webkitAudioContext;
    if(!Ctor)throw Error('当前浏览器不支持 Web Audio，无法在本机转换。请改用 Safari 或电脑浏览器。');
    let ctx;
    try{ctx=new Ctor({sampleRate:44100});}catch(_){ctx=new Ctor();}
    try{
      if(ctx.resume)await ctx.resume();
      aborted(signal);
      onProgress?.(0.12);
      let buffer;
      try{
        buffer=await ctx.decodeAudioData((await file.arrayBuffer()).slice(0));
      }catch(_){
        throw Error('当前浏览器无法解码该视频的音轨。可能是编码不受支持（如部分 HEVC / 特殊音轨）、无音轨、文件损坏，或微信内置浏览器内存不足。请改用 Safari 或电脑上的 Chrome / Edge，不要把原视频当作伴奏上传。');
      }
      aborted(signal);
      if(!buffer||!buffer.length||!buffer.numberOfChannels)throw Error('视频没有可导出的音轨');
      onProgress?.(0.38);
      return buffer;
    }finally{
      try{await ctx.close();}catch(_){ }
    }
  }

  function nearestLameRate(rate){
    if(LAME_RATES.includes(rate))return rate;
    return LAME_RATES.reduce((best,cur)=>Math.abs(cur-rate)<Math.abs(best-rate)?cur:best,44100);
  }

  function resample(pcm,from,to){
    if(from===to)return pcm;
    const ratio=from/to, length=Math.max(1,Math.round(pcm[0].length/ratio));
    return pcm.map(ch=>{
      const out=new Int16Array(length);
      for(let i=0;i<length;i++){
        const x=i*ratio, i0=Math.floor(x), i1=Math.min(ch.length-1,i0+1), t=x-i0;
        out[i]=(ch[i0]*(1-t)+ch[i1]*t)|0;
      }
      return out;
    });
  }

  async function convert(file,opts={}){
    const format=opts.format==='wav'?'wav':'mp3';
    const kbps=format==='mp3'?(Number(opts.bitrate)===320?320:192):null;
    const maxBytes=Number(opts.maxBytes)||0;
    const onProgress=typeof opts.onProgress==='function'?opts.onProgress:()=>{};
    aborted(opts.signal);
    if(!file||!VIDEO_EXT.test(file.name||''))throw Error('请选择 mp4、mov、m4v 或 webm 视频');
    const probed=await inspect(file,opts);
    onProgress(0.05);
    const estimated=format==='wav'?probed.estimated.wav:probed.estimated[kbps===320?'mp3_320':'mp3_192'];
    if(maxBytes && estimated>maxBytes){
      const e=Error(format==='wav'
        ?`预估 WAV 约 ${formatBytes(estimated)}，超过当前单文件上限 ${formatBytes(maxBytes)}。请改用 MP3，或由管理员在附件设置中提高上限（最高 90 MB）。未开始转换，也未上传。`
        :`预估 MP3 ${kbps} kbps 约 ${formatBytes(estimated)}，超过当前单文件上限 ${formatBytes(maxBytes)}。请改用较低码率，或由管理员提高附件上限。未开始转换，也未上传。`);
      e.code='oversize';e.estimated=estimated;throw e;
    }
    if(format==='mp3')await loadLame();
    aborted(opts.signal);
    const buffer=await decode(file,opts.signal,onProgress);
    aborted(opts.signal);
    const raw=toInt16(buffer);
    let sampleRate=raw.sampleRate, pcm=raw.pcm, channels=raw.channels;
    if(format==='mp3' && !LAME_RATES.includes(sampleRate)){
      const next=nearestLameRate(sampleRate);
      pcm=resample(pcm,sampleRate,next);
      sampleRate=next;
    }
    const bytes=format==='wav'?writeWav(pcm,sampleRate,onProgress,opts.signal):await writeMp3(await loadLame(),pcm,sampleRate,kbps,onProgress,opts.signal);
    aborted(opts.signal);
    const info=verify(bytes,format,kbps,sampleRate,channels);
    if(maxBytes && bytes.length>maxBytes){
      const e=Error(`导出文件 ${formatBytes(bytes.length)} 超过当前单文件上限 ${formatBytes(maxBytes)}，未加入上传。请改用 MP3 或提高上限。`);
      e.code='oversize';throw e;
    }
    onProgress(1);
    const ext=format==='wav'?'wav':'mp3';
    const mime=format==='wav'?'audio/wav':'audio/mpeg';
    const out=new File([bytes],`${probed.title}.${ext}`,{type:mime,lastModified:Date.now()});
    return {file:out,info:{...info,duration:buffer.duration,size:bytes.length,sourceName:file.name,title:probed.title,label:info.label+` · ${formatBytes(bytes.length)}`}};
  }

  global.Song118={
    inspect,convert,estimateWavBytes,estimateMp3Bytes,formatBytes,basename,VIDEO_EXT,MP3_RATES,
    loadLame,verify,parseMp3Frames
  };
})(typeof window!=='undefined'?window:globalThis);
