// V3.12.57 EQ 音色调节：9 段静态 EQ + 4 路动态 EQ + 智能频谱校正 + 动态补偿（频谱填充 + 多段向上压缩）+ 响度匹配 + 软限幅。
// 全部本地处理；分段解码，滤波器状态跨段连续，因此分段接缝与整首处理结果一致。试听与导出使用同一套 createProcessor。
(function(global){
'use strict';
const BANDS=[
 {f:60,type:'lowshelf',label:'60 Hz',tip:'低音（架式）',lo:20,hi:90},
 {f:120,type:'peaking',label:'120 Hz',tip:'低音力度',lo:90,hi:180},
 {f:250,type:'peaking',label:'250 Hz',tip:'低中（浑浊感）',lo:180,hi:355},
 {f:500,type:'peaking',label:'500 Hz',tip:'中低（厚度）',lo:355,hi:710},
 {f:1000,type:'peaking',label:'1 kHz',tip:'中频（存在感）',lo:710,hi:1420},
 {f:2000,type:'peaking',label:'2 kHz',tip:'中高（清晰度）',lo:1420,hi:2840},
 {f:4000,type:'peaking',label:'4 kHz',tip:'高中（亮度 / 刺耳）',lo:2840,hi:5680},
 {f:8000,type:'peaking',label:'8 kHz',tip:'高频（齿音 / 细节）',lo:5680,hi:11360},
 {f:12000,type:'highshelf',label:'12 kHz',tip:'空气感（架式）',lo:11360,hi:20000}
];
const PEAK_Q=1.2;
// 参考频谱：各倍频程能量相对 1 kHz 的 dB（平衡良好的流行 / 伴奏混音平均值的近似）。
const TARGET=[5.5,5,3.5,2,0,-3,-6.5,-11,-17];
// 响度权重（近似中等音量下的等响曲线），避免低频提升主导响度补偿。
const LOUD_W=[0.3,0.55,0.8,1,1,1.1,1.1,0.8,0.5];
const DYN={
 deess:{name:'齿音控制',tip:'7 kHz 附近，“嘶、次、齿”过响时才压下',sc:'bandpass',scF:7000,scQ:1.2,type:'peaking',f:7000,q:1.4,ratio:3,max:6,att:1.5,rel:60,th:-19,lo:5000,hi:10000},
 harsh:{name:'刺耳控制',tip:'3 kHz 附近，高音、铜管、镲片刺耳时才压下',sc:'bandpass',scF:3000,scQ:1.4,type:'peaking',f:3000,q:1.4,ratio:2,max:4,att:5,rel:120,th:-13,lo:2200,hi:4400},
 mud:{name:'浑浊控制',tip:'300 Hz 附近，低中频堆积发闷时才压下',sc:'bandpass',scF:300,scQ:1.4,type:'peaking',f:300,q:1.2,ratio:2,max:3.5,att:10,rel:150,th:-6,lo:220,hi:440},
 low:{name:'低频稳定',tip:'120 Hz 以下，底鼓 / 贝斯轰头时才压下',sc:'lowpass',scF:120,scQ:0.7071,type:'lowshelf',f:120,q:0.7071,ratio:2,max:3,att:15,rel:200,th:-2.5,lo:20,hi:120}
};
const PRESETS={
 natural:{name:'自然优化',desc:'不加明显色彩，只做轻度齿音控制；配合“一键智能优化”时以频谱校正为主。',gains:[0,0,0,0,0,0,0,0,0],hpf:25,dyn:['deess']},
 warm:{name:'温暖饱满',desc:'低音和中低更厚，略收高频与 2–8 kHz 的硬度，适合抒情、民歌、偏亮的录音。',gains:[2,1.5,1,0,-0.5,0,-1,-1,-1],hpf:25,dyn:['deess','harsh']},
 bright:{name:'明亮通透',desc:'减少低中频浑浊，提升 4 kHz 以上的清晰与空气感；同时开启齿音控制防止刺耳。',gains:[0,0,-0.5,-1.5,-0.5,0,1,2,3],hpf:30,dyn:['deess','mud']},
 vocal:{name:'人声突出',desc:'收低频与 250 Hz 浑浊，提升 2–4 kHz 人声清晰度，适合 AI 分离出的人声、朗诵、示范唱。',gains:[-1,-1,-1.5,-2,-0.5,0.5,2.5,2,1],hpf:60,dyn:['deess','mud']},
 karaoke:{name:'练唱伴奏（给人声让位）',desc:'在 1–4 kHz 人声频段让出约 2–3 dB 空间，低音和空气感略加，现场唱时人声更容易“浮”在伴奏上。',gains:[1.5,1,0,-0.5,-1,-2,-3,-2,1.5],hpf:30,dyn:['mud']},
 bass:{name:'低音浑厚',desc:'低音明显加强，同时开启低频稳定和浑浊控制，避免轰头和发闷。',gains:[4,3,1,-1,0,0,0,0.5,1],hpf:25,dyn:['low','mud']},
 classroom:{name:'教室 / 礼堂扩声',desc:'大空间低频容易共振：切 70 Hz 以下，减 250 Hz 浑浊，略升 2–4 kHz 让后排听清。',gains:[-2,-1,-1,-2,-0.5,0.5,1,1,-1],hpf:70,dyn:['mud','harsh','low']},
 phone:{name:'手机 / 小音箱外放',desc:'小喇叭放不出 90 Hz 以下，切掉以免破音；提升 150–250 Hz 制造“听得见的低音”。',gains:[-3,0,2.5,1,0,0,-1,0,1],hpf:90,dyn:['low','harsh']},
 classical:{name:'古典 / 合唱自然',desc:'几乎不改中低频，只轻提 8 kHz 以上的空气感与泛音，保留原有动态。',gains:[0,0,0,-0.5,0,0,0,0.5,1.5],hpf:25,dyn:[]}
};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const round5=x=>Math.round(x*2)/2+0;

// RBJ Audio EQ Cookbook；shelf 使用 S=1，与 Web Audio BiquadFilterNode 一致（试听与导出同一曲线）。
function design(type,f,q,g,sr){
 const w=2*Math.PI*Math.min(f,sr*0.49)/sr,cs=Math.cos(w),sn=Math.sin(w),A=Math.pow(10,g/40);let b0,b1,b2,a0,a1,a2;
 if(type==='peaking'){const al=sn/(2*q);b0=1+al*A;b1=-2*cs;b2=1-al*A;a0=1+al/A;a1=-2*cs;a2=1-al/A;}
 else if(type==='lowshelf'){const s=2*Math.sqrt(A)*sn/2*Math.SQRT2;b0=A*((A+1)-(A-1)*cs+s);b1=2*A*((A-1)-(A+1)*cs);b2=A*((A+1)-(A-1)*cs-s);a0=(A+1)+(A-1)*cs+s;a1=-2*((A-1)+(A+1)*cs);a2=(A+1)+(A-1)*cs-s;}
 else if(type==='highshelf'){const s=2*Math.sqrt(A)*sn/2*Math.SQRT2;b0=A*((A+1)+(A-1)*cs+s);b1=-2*A*((A-1)+(A+1)*cs);b2=A*((A+1)+(A-1)*cs-s);a0=(A+1)-(A-1)*cs+s;a1=2*((A-1)-(A+1)*cs);a2=(A+1)-(A-1)*cs-s;}
 else if(type==='highpass'){const al=sn/(2*q);b0=(1+cs)/2;b1=-(1+cs);b2=(1+cs)/2;a0=1+al;a1=-2*cs;a2=1-al;}
 else if(type==='lowpass'){const al=sn/(2*q);b0=(1-cs)/2;b1=1-cs;b2=(1-cs)/2;a0=1+al;a1=-2*cs;a2=1-al;}
 else {const al=sn/(2*q);b0=al;b1=0;b2=-al;a0=1+al;a1=-2*cs;a2=1-al;}
 return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}
function magDb(c,f,sr){
 const w=2*Math.PI*f/sr,c1=Math.cos(w),s1=Math.sin(w),c2=Math.cos(2*w),s2=Math.sin(2*w);
 const nr=c[0]+c[1]*c1+c[2]*c2,ni=-(c[1]*s1+c[2]*s2),dr=1+c[3]*c1+c[4]*c2,di=-(c[3]*s1+c[4]*s2);
 return 10*Math.log10((nr*nr+ni*ni)/(dr*dr+di*di)+1e-30);
}
function staticFilters(s,sr=44100){
 const list=[];if(s.hpf>0)list.push(design('highpass',s.hpf,0.7071,0,sr));
 BANDS.forEach((b,i)=>{const g=Number(s.gains[i])||0;if(Math.abs(g)>=0.05)list.push(design(b.type,b.f,PEAK_Q,g,sr));});
 return list;
}
function responseDb(s,f,sr=44100){let d=0;for(const c of staticFilters(s,sr))d+=magDb(c,f,sr);return d;}
// 响度补偿：用（实测或参考）频谱 × 等响权重 加权平均增益，抵消 EQ 带来的整体响度变化，便于公平对比。
function makeupDb(s,sr=44100){
 if(!s.autoLevel)return 0;const filters=staticFilters(s,sr);const base=s.weights||TARGET.map(d=>Math.pow(10,d/10));
 let num=0,den=0;BANDS.forEach((b,i)=>{const w=base[i]*LOUD_W[i],f=Math.sqrt(b.lo*b.hi);let d=0;for(const c of filters)d+=magDb(c,f,sr);num+=w*Math.pow(10,d/10);den+=w;});
 return clamp(-10*Math.log10(num/den),-12,12);
}
function defaults(key='natural'){
 const p=PRESETS[key]||PRESETS.natural,dyn={};for(const k of Object.keys(DYN))dyn[k]={on:p.dyn.includes(k),th:DYN[k].th};
 return {preset:key in PRESETS?key:'natural',gains:p.gains.slice(),hpf:p.hpf,out:0,autoLevel:true,amount:0.6,dyn,weights:null,smart:false,comp:{on:false,th:-28,ratio:1.7,maxLow:0,maxMid:0,maxHigh:0,att:12,rel:160}};
}

// ---------- 分段解码（与移调模块一致的 MP3 帧 / WAV 块边界） ----------
async function* decoded(file,ctx,abort){
 if(!global.SongChunk126?.mp3Segments||!global.SongChunk126?.wavSegments)throw Error('网站分段模块版本不匹配');
 const name=String(file.name||'').toLowerCase(),mp3=/\.mp3$/.test(name)||file.type==='audio/mpeg',wav=/\.wav$/.test(name)||/wav/.test(file.type||'');
 if(!mp3&&!wav)throw Error('为保护手机内存，EQ 支持 MP3 和 PCM WAV；M4A/OGG 请先用视频转音频工具转换成 MP3');
 if(!file.size||file.size>150*1048576)throw Error('音频大小须在 0 至 150MiB 之间');
 const sig={get aborted(){return abort()}},plan={core:30,lead:1,trail:1};
 const it=mp3?global.SongChunk126.mp3Segments(file,sig,plan):global.SongChunk126.wavSegments(file,sig,plan);
 const findOffset=global.SongChunk126.findOffset,W=4096;
 let rate=0,channels=0,count=0,tail=null,written=0;
 for await(const seg of it){
  if(abort())throw Error('已取消');count++;
  const raw=await seg.blob.arrayBuffer(),audio=await ctx.decodeAudioData(raw.slice(0));
  if(!rate){rate=audio.sampleRate;channels=Math.min(2,audio.numberOfChannels);}
  if(rate!==audio.sampleRate||channels!==Math.min(2,audio.numberOfChannels))throw Error('分段音频的声道数或采样率发生变化');
  const lead=Math.round((seg.leadingSeconds||0)*rate),B=Math.round(seg.startSeconds*rate),E=Math.round(seg.endSeconds*rate),wanted=E-B;
  const L=audio.getChannelData(0),R=channels>1?audio.getChannelData(1):L,mono=(a,len)=>{const o=new Float32Array(Math.max(0,len));for(let i=0;i<o.length;i++)o[i]=(L[a+i]+R[a+i])*0.5;return o;};
  // MP3 解码器在每段开头可能多出数百采样的延迟：用上一段的后置重叠做互相关对齐，避免接缝处重复 / 跳音。
  let off=0;if(tail&&findOffset){const f=findOffset(tail,mono(0,audio.length),lead);off=f.off;}
  const base=lead+off;if(base<0)throw Error('第 '+count+' 段对齐位置无效');
  const n=Math.min(wanted,Math.max(0,audio.length-base));
  if(n<wanted-Math.round(rate*0.15))throw Error('第 '+count+' 段解码不完整，已停止，避免出现空白');
  if(!n)continue;
  const ch=[];for(let c=0;c<channels;c++)ch.push(audio.getChannelData(c).slice(base,base+n));
  const t0=base+wanted;tail=!seg.last&&n===wanted&&audio.length-t0>=W?mono(t0,W):null;written+=n;
  yield {ch,rate,channels,count,percent:seg.sourceEnd/file.size};
 }
}

// ---------- 频谱分析（一键智能优化） ----------
function fft(re,im){
 const n=re.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
 for(let len=2;len<=n;len<<=1){const a=-2*Math.PI/len,wr=Math.cos(a),wi=Math.sin(a);for(let i=0;i<n;i+=len){let cr=1,ci=0;for(let k=0;k<len/2;k++){const p=i+k,q=p+len/2,tr=re[q]*cr-im[q]*ci,ti=re[q]*ci+im[q]*cr;re[q]=re[p]-tr;im[q]=im[p]-ti;re[p]+=tr;im[p]+=ti;const nr=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=nr;}}}
}
const pct=(a,p)=>{if(!a.length)return NaN;const s=a.slice().sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*(s.length-1)))];};
async function analyze(file,opt={}){
 const abort=()=>!!opt.cancelled?.();const ctx=new (global.AudioContext||global.webkitAudioContext)({sampleRate:44100});
 const N=4096,win=new Float64Array(N);for(let i=0;i<N;i++)win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(N-1));
 const sum=new Float64Array(BANDS.length),rel={};for(const k of Object.keys(DYN))rel[k]=[];
 let frames=0,rumble=0,lowRef=0,peak=0,sq=0,samples=0,carry=null;
 try{
  for await(const d of decoded(file,ctx,abort)){
   opt.onProgress?.({percent:Math.round(d.percent*100),segment:d.count,stage:'分析频谱'});
   const n=d.ch[0].length,mono=new Float32Array(n);for(let c=0;c<d.channels;c++){const x=d.ch[c];for(let i=0;i<n;i++){mono[i]+=x[i]/d.channels;const a=Math.abs(x[i]);if(a>peak)peak=a;}}
   for(let i=0;i<n;i++)sq+=mono[i]*mono[i];samples+=n;
   const hop=Math.round(d.rate*0.1),bin=d.rate/N;
   for(let p=0;p+N<=n;p+=hop){
    let e=0;for(let i=p;i<p+N;i++)e+=mono[i]*mono[i];if(e/N<1e-6)continue; // < -60 dBFS 视为静音，不参与统计
    const re=new Float64Array(N),im=new Float64Array(N);for(let i=0;i<N;i++)re[i]=mono[p+i]*win[i];fft(re,im);
    const pw=new Float64Array(N/2);let total=0;for(let k=1;k<N/2;k++){pw[k]=re[k]*re[k]+im[k]*im[k];const f=k*bin;if(f>=20&&f<=20000)total+=pw[k];}
    if(total<=0)continue;frames++;
    const band=(lo,hi)=>{let s=0;for(let k=Math.max(1,Math.ceil(lo/bin));k<=Math.min(N/2-1,Math.floor(hi/bin));k++)s+=pw[k];return s;};
    BANDS.forEach((b,i)=>{sum[i]+=band(b.lo,b.hi)/total;});
    rumble+=band(1,28)/total;lowRef+=band(40,90)/total;
    for(const [k,v] of Object.entries(DYN))rel[k].push(10*Math.log10(band(v.lo,v.hi)/total+1e-12));
   }
   await new Promise(r=>setTimeout(r,0));
  }
 }finally{try{await ctx.close()}catch(_){}}
 if(frames<5)throw Error('有效音频太短或几乎静音，无法分析');
 const bandDb=Array.from(sum,v=>10*Math.log10(v/frames+1e-12));
 const dyn={};for(const k of Object.keys(DYN))dyn[k]={p50:pct(rel[k],0.5),p85:pct(rel[k],0.85),p90:pct(rel[k],0.9),p95:pct(rel[k],0.95)};
 return {bandDb,weights:Array.from(sum,v=>v/frames),dyn,frames,rumbleDb:10*Math.log10((rumble+1e-12)/(lowRef+1e-12)),peakDb:20*Math.log10(peak+1e-12),rmsDb:10*Math.log10(sq/Math.max(1,samples)+1e-12),seconds:samples/44100};
}
function smart(a,presetKey='natural'){
 const p=PRESETS[presetKey]||PRESETS.natural,s=defaults(presetKey),report=[];
 const mid=[2,3,4,5,6],mean=arr=>mid.reduce((t,i)=>t+arr[i],0)/mid.length;
 const mN=a.bandDb.map(v=>v-mean(a.bandDb)),tN=TARGET.map(v=>v-mean(TARGET));
 let corr=mN.map((m,i)=>{const diff=tN[i]-m;let c=clamp(0.55*diff,-4.5,3.5);
  if(i>=7&&diff>15){c=Math.min(c,1.5);if(i===8)report.push('12 kHz 以上几乎没有内容（常见于低码率 MP3），只轻提，避免放大噪声');}
  if(i===0&&diff>10){c=Math.min(c,2);report.push('原录音超低音很少，只轻补，避免小音箱破音');}
  return c;});
 corr=corr.map((c,i)=>i===0?0.67*c+0.33*corr[1]:i===corr.length-1?0.67*c+0.33*corr[i-1]:0.25*corr[i-1]+0.5*c+0.25*corr[i+1]);
 const names=['超低音','低音','低中频','中低频','中频','中高频','高中频','高频','空气感'];
 corr.forEach((c,i)=>{const diff=mN[i]-tN[i];if(Math.abs(diff)>=2.5&&Math.abs(c)>=1)report.push(names[i]+'（'+BANDS[i].label+'）比参考'+(diff>0?'多':'少')+' '+Math.abs(diff).toFixed(1)+' dB → '+(c<0?'减':'加')+' '+Math.abs(c).toFixed(1)+' dB');});
 s.gains=corr.map((c,i)=>clamp(round5(c+p.gains[i]),-12,12));
 if(a.rumbleDb>-6){s.hpf=Math.max(p.hpf,35);report.push('28 Hz 以下有明显隆隆声 / 震动 → 低切提高到 '+s.hpf+' Hz');}
 const th={deess:a.dyn.deess.p90,harsh:a.dyn.harsh.p85,mud:a.dyn.mud.p85,low:a.dyn.low.p85};
 for(const k of Object.keys(DYN)){if(Number.isFinite(th[k]))s.dyn[k].th=round5(clamp(th[k],DYN[k].th-10,DYN[k].th+8));}
 const spread=k=>a.dyn[k].p95-a.dyn[k].p50;
 if(!s.dyn.deess.on&&spread('deess')>7){s.dyn.deess.on=true;report.push('齿音 / 镲片峰值明显（突出 '+spread('deess').toFixed(1)+' dB）→ 开启齿音控制');}
 if(!s.dyn.harsh.on&&a.dyn.harsh.p90>-10){s.dyn.harsh.on=true;report.push('3 kHz 附近偶有刺耳 → 开启刺耳控制');}
 if(!s.dyn.mud.on&&(mN[2]-tN[2]>2||spread('mud')>8)){s.dyn.mud.on=true;report.push('低中频时有堆积 → 开启浑浊控制');}
 if(!s.dyn.low.on&&(mN[0]-tN[0]>3||spread('low')>9)){s.dyn.low.on=true;report.push('低音起伏较大 → 开启低频稳定');}
 s.weights=a.weights;s.smart=true;
 if(!report.length)report.push('频谱已经接近参考曲线，只做轻微修饰');
 return {settings:s,report};
}


function compensate(a,base){
 const s=JSON.parse(JSON.stringify(base&&base.gains?base:defaults(base&&base.preset||'natural')));
 if(!s.dyn)Object.assign(s,defaults(s.preset||'natural'),s);
 if(!s.comp)s.comp={on:false,th:-28,ratio:1.7,maxLow:0,maxMid:0,maxHigh:0,att:12,rel:160};
 const report=[],names=['超低音','低音','低中频','中低频','中频','中高频','高中频','高频','空气感'];
 const mid=[2,3,4,5,6],mean=arr=>mid.reduce((t,i)=>t+arr[i],0)/mid.length;
 const mN=a.bandDb.map(v=>v-mean(a.bandDb)),tN=TARGET.map(v=>v-mean(TARGET));
 const highNoise=(tN[8]-mN[8]>15)||(tN[7]-mN[7]>15),emptySub=(tN[0]-mN[0]>10);
 let fill=mN.map((m,i)=>{const diff=tN[i]-m;if(diff<1)return 0;let c=Math.min(4,0.7*diff);if(i>=7&&highNoise)c=Math.min(c,1.5);if(i===0&&emptySub)c=Math.min(c,2);return c;});
 fill=fill.map((c,i)=>i===0?0.67*c+0.33*fill[1]:i===fill.length-1?0.67*c+0.33*fill[i-1]:0.25*fill[i-1]+0.5*c+0.25*fill[i+1]);
 s.gains=fill.map((c,i)=>clamp(round5((Number(s.gains[i])||0)+c),-12,12));
 fill.forEach((c,i)=>{if(c>=1)report.push(names[i]+'（'+BANDS[i].label+'）偏弱约 '+(tN[i]-mN[i]).toFixed(1)+' dB → 补 '+c.toFixed(1)+' dB');});
 const crest=a.peakDb-a.rmsDb,midWeak=(tN[3]-mN[3]+tN[4]-mN[4]+tN[5]-mN[5])/3,lowWeak=(tN[0]-mN[0]+tN[1]-mN[1])/2,highWeak=(tN[7]-mN[7]+tN[8]-mN[8])/2;
 let th=-28,ratio=1.7,maxLow=0,maxMid=0,maxHigh=0,att=12,rel=160;
 if(a.rmsDb<-18){const lift=clamp((-18-a.rmsDb)*0.45,1,6);maxMid=Math.max(maxMid,lift);maxLow=Math.max(maxLow,lift*0.7);maxHigh=Math.max(maxHigh,lift*0.5);th=clamp(a.rmsDb-6,-36,-22);report.push('响度偏轻（RMS '+a.rmsDb.toFixed(1)+' dBFS）→ 向上压缩补满约 '+lift.toFixed(1)+' dB');}
 if(crest>14&&a.rmsDb<-10){const thin=clamp((crest-14)*0.35,0.5,4);maxMid=Math.max(maxMid,thin);maxLow=Math.max(maxLow,thin*0.6);report.push('动态偏大、听感偏瘦（峰均比 '+crest.toFixed(1)+' dB）→ 补满中低频');}
 if(midWeak>=2){maxMid=Math.max(maxMid,clamp(midWeak*0.5,1,4));report.push('中频不满（相对参考弱 '+midWeak.toFixed(1)+' dB）→ 中频向上补满');}
 if(lowWeak>=2&&!emptySub){maxLow=Math.max(maxLow,clamp(lowWeak*0.4,0.8,3.5));report.push('低频偏薄 → 低频向上补满');}
 if(highWeak>=2&&!highNoise){const pres=clamp(highWeak*0.25,0.5,1.5);s.gains[7]=clamp(round5(s.gains[7]+pres),-12,12);s.gains[8]=clamp(round5(s.gains[8]+pres*0.8),-12,12);maxHigh=Math.max(maxHigh,Math.min(2,pres));report.push('高频偏弱、但不是噪声底 → 轻度空气感与高频补满');}
 else if(highNoise)report.push('高频几乎没有内容（常见于低码率网络音频），只轻补静态频段，避免放大噪声');
 if(a.rumbleDb>-6){s.hpf=Math.max(s.hpf||0,35);report.push('超低频有隆隆声 → 低切 '+s.hpf+' Hz');}
 if((fill[7]>=1||fill[8]>=1||(highWeak>=2&&!highNoise))&&s.dyn&&!s.dyn.deess.on){s.dyn.deess.on=true;report.push('已同时开启齿音控制，避免补高频时齿音过亮');}
 if(a.rmsDb>-12&&crest<8){maxLow=Math.min(maxLow,1.5);maxMid=Math.min(maxMid,1.5);maxHigh=Math.min(maxHigh,1);report.push('整体已经较响且比较满，只做轻度补满，避免压扁峰值');}
 const on=maxLow>0.3||maxMid>0.3||maxHigh>0.3||fill.some(c=>c>=0.8);
 s.comp={on,th:round5(th),ratio,maxLow:round5(maxLow),maxMid:round5(maxMid),maxHigh:round5(maxHigh),att,rel};
 if(!on){s.comp.on=false;if(!report.length)report.push('频谱和响度已经比较完整，无需明显补偿');}
 s.preset='custom';if(!s.weights&&a.weights)s.weights=a.weights;
 if(!report.length)report.push('已按本曲做轻度动态补偿');
 return {settings:s,report};
}

// ---------- 渲染 ----------
function bq(c,st,x,from,to){let z1=st[0],z2=st[1];const b0=c[0],b1=c[1],b2=c[2],a1=c[3],a2=c[4];for(let i=from;i<to;i++){const xi=x[i],y=b0*xi+z1;z1=b1*xi-a1*y+z2;z2=b2*xi-a2*y;x[i]=y;}st[0]=z1;st[1]=z2;}
function bq1(c,st,x){const y=c[0]*x+st[0];st[0]=c[1]*x-c[3]*y+st[1];st[1]=c[2]*x-c[4]*y;return y;}
function createProcessor(s,sr,channels){
 const stat=staticFilters(s,sr).map(c=>({c,st:Array.from({length:channels},()=>[0,0])}));
 const ms=t=>1-Math.exp(-1/(t*0.001*sr));const BLK=32,blk=t=>1-Math.exp(-BLK/(t*0.001*sr));
 const dyn=Object.keys(DYN).filter(k=>s.dyn?.[k]?.on).map(k=>{const d=DYN[k];return {k,d,th:Number(s.dyn[k].th),max:d.max*clamp(Number(s.amount),0,1),sc:design(d.sc,d.scF,d.scQ,0,sr),scSt:[0,0],env:0,gr:0,aA:ms(d.att),aR:ms(d.rel),gA:blk(d.att),gR:blk(d.rel),st:Array.from({length:channels},()=>[0,0]),maxGr:0,c:design(d.type,d.f,d.q,0,sr)};});
 const fA=ms(5),fR=ms(80);let envF=0;const gain=Math.pow(10,(makeupDb(s,sr)+(Number(s.out)||0))/20);
 const knee=Math.pow(10,-1.5/20),ceil=0.98;let limited=0,total=0,pos=0;
 const comp=s.comp&&s.comp.on?s.comp:null;
 const maxDb=comp?[Math.max(0,Number(comp.maxLow)||0),Math.max(0,Number(comp.maxMid)||0),Math.max(0,Number(comp.maxHigh)||0)]:[0,0,0];
 const useComp=!!comp&&maxDb.some(v=>v>0),Qb=0.7071;
 const lp1=useComp?design('lowpass',200,Qb,0,sr):null,hp1=useComp?design('highpass',200,Qb,0,sr):null,lp2=useComp?design('lowpass',4500,Qb,0,sr):null,hp2=useComp?design('highpass',4500,Qb,0,sr):null;
 const cst=useComp?Array.from({length:channels},()=>Array.from({length:8},()=>[0,0])):null;
 const envC=[0,0,0],maxUp=[0,0,0],cAtt=ms(Number(comp&&comp.att)||12),cRel=ms(Number(comp&&comp.rel)||160),cTh=Number(comp&&comp.th)||-28,cK=1-1/Math.max(1.05,Number(comp&&comp.ratio)||1.7);
 return {gain,dyn,process(ch){
  const n=ch[0].length;for(const f of stat)for(let c=0;c<channels;c++)bq(f.c,f.st[c],ch[c],0,n);
  if(dyn.length){
   const mono=new Float32Array(n);for(let c=0;c<channels;c++){const x=ch[c];for(let i=0;i<n;i++)mono[i]+=x[i]/channels;}
   const sc=dyn.map(x=>{const a=mono.slice();bq(x.sc,x.scSt,a,0,n);return a;});
   // 块网格对齐全曲采样位置：每 32 个采样更新一次增益，下一块生效，分段处理与整首处理逐样本一致。
   for(let p=0;p<n;){const e=Math.min(n,p+BLK-((pos+p)%BLK));
    for(let i=p;i<e;i++){const q=mono[i]*mono[i];envF+=(q>envF?fA:fR)*(q-envF);}
    dyn.forEach((x,j)=>{const a=sc[j];for(let i=p;i<e;i++){const q=a[i]*a[i];x.env+=(q>x.env?x.aA:x.aR)*(q-x.env);}
     for(let k=0;k<channels;k++)bq(x.c,x.st[k],ch[k],p,e);
     if((pos+e)%BLK===0){let target=0;if(envF>1e-7){const r=10*Math.log10((x.env+1e-12)/(envF+1e-12)),ex=r-x.th;if(ex>0)target=Math.min(x.max,ex*(1-1/x.d.ratio));}
      x.gr+=(target>x.gr?x.gA:x.gR)*(target-x.gr);if(x.gr>x.maxGr)x.maxGr=x.gr;x.c=design(x.d.type,x.d.f,x.d.q,-x.gr,sr);}
    });
    p=e;}
  }
  if(useComp){
   const band=Array.from({length:channels},()=>[0,0,0]);
   for(let i=0;i<n;i++){
    let lSum=0,mSum=0,hSum=0;
    for(let c=0;c<channels;c++){
     const x=ch[c][i],st=cst[c];
     const low=bq1(lp1,st[1],bq1(lp1,st[0],x)),rest=bq1(hp1,st[3],bq1(hp1,st[2],x));
     const midv=bq1(lp2,st[5],bq1(lp2,st[4],rest)),high=bq1(hp2,st[7],bq1(hp2,st[6],rest));
     band[c][0]=low;band[c][1]=midv;band[c][2]=high;lSum+=low;mSum+=midv;hSum+=high;
    }
    const pw=[(lSum/channels)*(lSum/channels),(mSum/channels)*(mSum/channels),(hSum/channels)*(hSum/channels)];
    for(let b=0;b<3;b++){envC[b]+=(pw[b]>envC[b]?cAtt:cRel)*(pw[b]-envC[b]);let boost=0;if(maxDb[b]>0){const level=10*Math.log10(envC[b]+1e-12);if(level<cTh)boost=Math.min(maxDb[b],(cTh-level)*cK);}if(boost>maxUp[b])maxUp[b]=boost;const g=Math.pow(10,boost/20);for(let c=0;c<channels;c++)band[c][b]*=g;}
    for(let c=0;c<channels;c++)ch[c][i]=band[c][0]+band[c][1]+band[c][2];
   }
  }
  // 响度补偿 + 软膝限幅（-1.5 dBFS 起压，上限 -0.18 dBFS），防止提升后削波。
  for(let c=0;c<channels;c++){const x=ch[c];for(let i=0;i<n;i++){let y=x[i]*gain;const a=Math.abs(y);if(a>knee){y=Math.sign(y)*(knee+(ceil-knee)*Math.tanh((a-knee)/(ceil-knee)));if(a>1)limited++;}x[i]=y;}total+=n;}
  pos+=n;
  return ch;
 },stats:()=>({limitedRatio:total?limited/total:0,dyn:dyn.map(x=>({key:x.k,name:x.d.name,maxGr:x.maxGr})),up:useComp?{low:maxUp[0],mid:maxUp[1],high:maxUp[2]}:null})};
}
function wavHeader(rate,channels,bytes){const b=new ArrayBuffer(44),v=new DataView(b),w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};w(0,'RIFF');v.setUint32(4,36+bytes,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,rate,true);v.setUint32(28,rate*channels*2,true);v.setUint16(32,channels*2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,bytes,true);return b;}
function pcm16(ch){const n=ch[0].length,c=ch.length,b=new ArrayBuffer(n*c*2),v=new DataView(b);let o=0;for(let i=0;i<n;i++)for(let k=0;k<c;k++){const s=Math.max(-1,Math.min(1,ch[k][i]));v.setInt16(o,s<0?Math.round(s*32768):Math.round(s*32767),true);o+=2;}return b;}
async function render(file,s,opt={}){
 if(!navigator.storage?.getDirectory)throw Error('当前浏览器不支持 OPFS 临时文件存储');
 const abort=()=>!!opt.cancelled?.();const folder=await navigator.storage.getDirectory(),temp='eq146-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.wav',handle=await folder.getFileHandle(temp,{create:true}),writer=await handle.createWritable();
 const ctx=new (global.AudioContext||global.webkitAudioContext)({sampleRate:44100});let bytes=0,rate=0,channels=0,proc=null,closed=false,count=0;
 const cleanup=async()=>{try{if(!closed)await writer.abort();}catch(_){}try{await folder.removeEntry(temp);}catch(_){}};
 try{
  await writer.write(new Uint8Array(44));
  for await(const d of decoded(file,ctx,abort)){
   if(!proc){rate=d.rate;channels=d.channels;proc=createProcessor(s,rate,channels);}
   count=d.count;opt.onProgress?.({percent:Math.min(97,Math.round(d.percent*97)),segment:d.count,stage:'EQ 处理'});
   proc.process(d.ch);if(abort())throw Error('已取消');
   const data=pcm16(d.ch);await writer.seek(44+bytes);await writer.write(new Blob([data]));bytes+=data.byteLength;
   await new Promise(r=>setTimeout(r,0));
  }
  if(!bytes)throw Error('没有生成音频');
  await writer.truncate(bytes+44);await writer.seek(0);await writer.write(new Blob([wavHeader(rate,channels,bytes)]));await writer.close();closed=true;
  const result=await handle.getFile();opt.onProgress?.({percent:100,segment:count,stage:'完成'});
  return {file:result,seconds:bytes/(rate*channels*2),segments:count,stats:proc.stats(),makeup:makeupDb(s,rate),cleanup:async()=>{try{await folder.removeEntry(temp)}catch(_){}}};
 }catch(e){await cleanup();throw e;}finally{try{await ctx.close()}catch(_){}}
}

// ---------- 实时试听（Web Audio 原生滤波器，与导出静态曲线相同；动态部分仅导出时生效） ----------
function preview(audio){
 try{if(navigator.audioSession)navigator.audioSession.type='playback';}catch(_){}
 const AC=global.AudioContext||global.webkitAudioContext;const ctx=new AC();const src=ctx.createMediaElementSource(audio);
 const hp=ctx.createBiquadFilter();hp.type='highpass';hp.Q.value=20*Math.log10(Math.SQRT1_2); // Web Audio 高通的 Q 以 dB 表示
 const nodes=BANDS.map(b=>{const n=ctx.createBiquadFilter();n.type=b.type;n.frequency.value=b.f;n.Q.value=PEAK_Q;return n;});
 const out=ctx.createGain(),lim=ctx.createDynamicsCompressor();lim.threshold.value=-1;lim.knee.value=0;lim.ratio.value=20;lim.attack.value=0.002;lim.release.value=0.1;
 hp.connect(nodes[0]);for(let i=1;i<nodes.length;i++)nodes[i-1].connect(nodes[i]);nodes[nodes.length-1].connect(out);out.connect(lim);lim.connect(ctx.destination);
 let bypass=false;src.connect(hp);
 return {ctx,
  update(s){const t=ctx.currentTime;hp.frequency.setTargetAtTime(s.hpf>0?s.hpf:5,t,0.02);nodes.forEach((n,i)=>n.gain.setTargetAtTime(Number(s.gains[i])||0,t,0.02));out.gain.setTargetAtTime(Math.pow(10,(makeupDb(s)+(Number(s.out)||0))/20),t,0.02);},
  setBypass(v){if(v===bypass)return;bypass=v;try{src.disconnect();}catch(_){}src.connect(v?ctx.destination:hp);},
  get bypass(){return bypass},
  async close(){try{src.disconnect()}catch(_){}try{await ctx.close()}catch(_){}}};
}
// V3.12.49：与导出完全一致的实时试听（AudioWorklet 运行同一套处理器）；不支持时退回上面的原生滤波器试听。
const WORKLET_V='v31257';
// 第一步（打开 EQ 时预先执行，不需要点击）：创建音频环境并加载处理器；第二步在点击时同步接入，保证 iPhone 能立即出声。
function livePrep(){
 const AC=global.AudioContext||global.webkitAudioContext;if(!AC||!global.AudioWorkletNode)return null;
 let ctx;try{ctx=new AC();}catch(_){return null;}if(!ctx.audioWorklet){try{ctx.close()}catch(_){}return null;}
 const prep={ctx,ok:null};
 prep.ready=ctx.audioWorklet.addModule('/songs115/eq146.js?v='+WORKLET_V).then(()=>ctx.audioWorklet.addModule('/songs115/eq148w.js?v='+WORKLET_V)).then(()=>prep.ok=true,()=>prep.ok=false);
 return prep;
}
function liveAttach(prep,audio){
 try{if(navigator.audioSession)navigator.audioSession.type='playback';}catch(_){}
 const ctx=prep.ctx,src=ctx.createMediaElementSource(audio);
 const node=new AudioWorkletNode(ctx,'eq148',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'explicit',channelInterpretation:'speakers'});
 src.connect(node);node.connect(ctx.destination);
 let bypass=false,last=null,timer=0,first=true;
 const send=()=>{timer=0;node.port.postMessage({s:bypass?null:last,instant:first});first=false;};
 return {ctx,exact:true,node,
  update(s){last=JSON.parse(JSON.stringify(s));if(first){send();return;}if(!timer)timer=setTimeout(send,60);},
  setBypass(v){if(v===bypass)return;bypass=v;clearTimeout(timer);send();},
  get bypass(){return bypass},
  async close(){clearTimeout(timer);try{src.disconnect();node.disconnect();}catch(_){}try{await ctx.close()}catch(_){}}};
}
global.SongEQ146={BANDS,PRESETS,DYN,TARGET,defaults,design,magDb,responseDb,makeupDb,analyze,smart,compensate,render,preview,livePrep,liveAttach,createProcessor,decoded,_fft:fft};
})(typeof window!=='undefined'?window:globalThis);
