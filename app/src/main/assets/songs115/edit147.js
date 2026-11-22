// V3.12.60 音频编辑全能升级：非破坏式片段表（EDL）+ 双轨混音/自动闪避 + 变速不变调（Signalsmith Stretch WASM）
// + 预备拍/Tap测速 + 一键去静音/自动打标 + KTV声道剥离 + 响度标准化(-16/-14 LUFS) + 选区倒放 + 实时录音插入 + ZIP打包导出。
(function(global){
'use strict';
const PI2=Math.PI/2,BUCKET=256,DECLICK=0.004;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const clone=x=>JSON.parse(JSON.stringify(x));
const len=c=>c.e-c.s;

// ---------- 片段表核心（纯函数，可在 Node 中测试） ----------
function project(rate=44100){return {rate,sources:{},clips:[],markers:[],chMode:'stereo',tempo:1,pitch:0,formant:true,denoise:0,comp:'off',reverb:'off',reverbMix:1,meta:null,chords:null,hq3:null,bg:null};}
function layout(P){const st=[];let pos=0;P.clips.forEach((c,i)=>{const s=i?pos-(c.xf||0):0;st.push(s);pos=s+len(c);});return {st,total:pos};}
function total(P){return layout(P).total;}
function slice(c,a,b){
 const L=len(c),rev=!!c.rev;
 const s=rev?c.e-b:c.s+a,e=rev?c.e-a:c.s+b;
 return {...c,s,e,rev,fades:(c.fades||[]).map(f=>({dir:f.dir,u0:f.u0+(f.u1-f.u0)*a/L,u1:f.u0+(f.u1-f.u0)*b/L}))};
}
// 交叉淡化重叠区内不能直接切：先把这处交叉淡化改成在重叠中点的硬接（两侧仍有 4ms 防爆音）。
function resolveOverlapAt(P,t){const {st}=layout(P);for(let i=1;i<P.clips.length;i++){const c=P.clips[i],xf=c.xf||0;if(xf>0&&t>=st[i]&&t<=st[i]+xf){const h=Math.floor(xf/2),p=P.clips[i-1],pxf=p.xf||0;P.clips[i-1]={...slice(p,0,len(p)-(xf-h)),xf:pxf};P.clips[i]={...slice(c,h,len(c)),xf:0};return true;}}return false;}
function splitAt(P,t){t=Math.round(t);resolveOverlapAt(P,t);const {st}=layout(P);for(let i=0;i<P.clips.length;i++){const c=P.clips[i],k=t-st[i];if(k>0&&k<len(c)){P.clips.splice(i,1,{...slice(c,0,k),xf:c.xf||0},{...slice(c,k,len(c)),xf:0});return i+1;}}
 for(let i=0;i<P.clips.length;i++)if(st[i]>=t)return i;return P.clips.length;}
function inside(P,a,b){const {st}=layout(P),idx=[];P.clips.forEach((c,i)=>{if(st[i]>=a&&st[i]+len(c)<=b&&len(c)>0)idx.push(i);});return {idx,st};}
function tidy(P){
 P.clips=P.clips.filter(c=>len(c)>0);
 for(let i=0;i<P.clips.length;i++){const c=P.clips[i];if(!i){c.xf=0;continue;}c.xf=Math.max(0,Math.min(c.xf||0,len(c),len(P.clips[i-1])));}
 for(let i=1;i<P.clips.length-1;i++){const c=P.clips[i],n=P.clips[i+1];if((c.xf||0)+(n.xf||0)>len(c))n.xf=Math.max(0,len(c)-(c.xf||0));}
 const out=[];
 for(const c of P.clips){
  const p=out[out.length-1],plain=x=>!(x.fades&&x.fades.length);
  const sameRev=p&&(!!p.rev===!!c.rev);
  const cont=p&&(c.src===null||(c.rev?p.s===c.e:p.e===c.s));
  if(p&&!c.xf&&plain(p)&&plain(c)&&p.gain===c.gain&&p.src===c.src&&sameRev&&cont){
   if(c.src===null)p.e+=len(c);else if(c.rev)p.s=c.s;else p.e=c.e;continue;
  }
  out.push(c);
 }
 P.clips=out;const T=total(P);P.markers=P.markers.filter(m=>m.t>=0&&m.t<=T).sort((x,y)=>x.t-y.t);return P;
}
function deleteRange(P,a,b){a=Math.round(a);b=Math.round(b);if(b<=a)return [];splitAt(P,a);splitAt(P,b);const {idx}=inside(P,a,b);if(!idx.length)return [];
 const removed=P.clips.splice(idx[0],idx.length);const n=P.clips[idx[0]];if(n)n.xf=0;
 P.markers=P.markers.filter(m=>!(m.t>a&&m.t<b)).map(m=>m.t>=b?{...m,t:m.t-(b-a)}:m);tidy(P);return removed;}
function copyRange(P,a,b){const Q=clone(P);splitAt(Q,a);splitAt(Q,b);const {idx}=inside(Q,a,b);const r=idx.map(i=>Q.clips[i]);if(r[0])r[0].xf=0;return r;}
function clipsLength(cs){let t=0;cs.forEach((c,i)=>{t+=len(c)-(i?(c.xf||0):0);});return t;}
function insertAt(P,t,clips){t=Math.round(clamp(t,0,total(P)));const i=splitAt(P,t),add=clone(clips);if(!add.length)return 0;add[0].xf=0;P.clips.splice(i,0,...add);const n=P.clips[i+add.length];if(n)n.xf=0;
 const L=clipsLength(add);P.markers=P.markers.map(m=>m.t>=t?{...m,t:m.t+L}:m);tidy(P);return L;}
function applyRange(P,a,b,fn){a=Math.round(a);b=Math.round(b);if(b<=a)return;splitAt(P,a);splitAt(P,b);const {idx,st}=inside(P,a,b);for(const i of idx)fn(P.clips[i],st[i],st[i]+len(P.clips[i]));tidy(P);}
function fade(P,a,b,dir){applyRange(P,a,b,(c,s,e)=>{(c.fades=c.fades||[]).push({dir,u0:(s-a)/(b-a),u1:(e-a)/(b-a)});});}
function gain(P,a,b,db){const g=Math.pow(10,db/20);applyRange(P,a,b,c=>{c.gain=Math.round(c.gain*g*1e6)/1e6;});}
function silence(P,a,b){applyRange(P,a,b,c=>{c.src=null;c.e=len(c);c.s=0;c.rev=false;c.fades=[];});}
function crop(P,a,b){const T=total(P);deleteRange(P,b,T);deleteRange(P,0,a);}
function append(P,clips,xf){const add=clone(clips);if(P.clips.length&&add.length)add[0].xf=Math.round(xf||0);else if(add[0])add[0].xf=0;P.clips.push(...add);tidy(P);}
function reverseRange(P,a,b){
 a=Math.round(a);b=Math.round(b);if(b<=a)return;
 splitAt(P,a);splitAt(P,b);const {idx}=inside(P,a,b);if(!idx.length)return;
 const seg=P.clips.slice(idx[0],idx[0]+idx.length).reverse().map(c=>({
  ...c,rev:c.src==null?false:!c.rev,xf:0,
  fades:(c.fades||[]).map(f=>({dir:f.dir==='in'?'out':'in',u0:1-f.u1,u1:1-f.u0}))
 }));
 P.clips.splice(idx[0],idx.length,...seg);
 const next=P.clips[idx[0]+seg.length];if(next)next.xf=0;
 tidy(P);
}
function srcClip(src){return {src:src.id,s:0,e:src.frames,gain:1,fades:[],xf:0,rev:false};}
function silentClip(n){return {src:null,s:0,e:Math.round(n),gain:1,fades:[],xf:0,rev:false};}

function gainAt(P,i,pos,D){
 const c=P.clips[i],L=len(c),prev=P.clips[i-1],next=P.clips[i+1],src=c.src!=null?P.sources[c.src]:null;let g=c.gain;
 const xin=c.xf||0,xout=next?.xf||0;
 if(xin&&pos<xin)g*=Math.sin(PI2*(pos+0.5)/xin);
 if(xout&&pos>=L-xout)g*=Math.cos(PI2*(pos-(L-xout)+0.5)/xout);
 // 不连续的拼接点两侧各做 4ms 线性淡化，防止剪切处“咔”声。
 const contIn=prev?(prev.src===c.src&&!!prev.rev===!!c.rev&&c.src!=null&&(c.rev?prev.s===c.e:prev.e===c.s)):(c.rev?(!src||c.e>=src.frames):c.s===0);
 const contOut=next?(next.src===c.src&&!!next.rev===!!c.rev&&c.src!=null&&(c.rev?next.e===c.s:next.s===c.e)):(c.rev?c.s===0:(!src||c.e>=src.frames));
 if(!xin&&!contIn&&pos<D)g*=(pos+0.5)/D;
 if(!xout&&!contOut&&pos>=L-D)g*=(L-pos-0.5)/D;
 for(const f of c.fades||[]){const u=clamp(f.u0+(f.u1-f.u0)*(pos+0.5)/L,0,1);g*=f.dir==='in'?Math.sin(PI2*u):Math.cos(PI2*u);}
 return g;
}

// ---------- 音频渲染（含倒放、KTV 声道模式、双轨混音 + 自动闪避） ----------
async function readBg(src,bgStart,n,loop){
 const L=new Float32Array(n),R=new Float32Array(n),F=src.frames;
 if(!F||!n)return {L,R};
 if(!loop){
  const s0=Math.max(0,bgStart),s1=Math.min(F,bgStart+n);
  if(s1>s0){const d=await src.read(s0,s1-s0);L.set(d.L,s0-bgStart);R.set(d.R,s0-bgStart);}
  return {L,R};
 }
 let written=0;
 while(written<n){
  const cur=bgStart+written;
  if(cur<0){const skip=Math.min(n-written,-cur);written+=skip;continue;}
  const off=((cur%F)+F)%F,chunk=Math.min(n-written,F-off);
  const d=await src.read(off,chunk);
  L.set(d.L,written);R.set(d.R,written);written+=chunk;
 }
 return {L,R};
}

async function renderRange(P,t0,n){
 t0=Math.round(t0);n=Math.max(0,Math.round(n));
 const out=[new Float32Array(n),new Float32Array(n)],{st}=layout(P),D=Math.round(P.rate*DECLICK);
 for(let i=0;i<P.clips.length;i++){
  const c=P.clips[i],s=st[i],L=len(c);if(s>=t0+n||s+L<=t0||c.src==null)continue;
  const o0=Math.max(t0,s),o1=Math.min(t0+n,s+L),m=o1-o0,src=P.sources[c.src];if(!src||m<=0)continue;
  if(c.rev){
   const d=await src.read(c.e-(o1-s),m);
   for(let j=0;j<m;j++){const g=gainAt(P,i,o0-s+j,D),k=m-1-j;out[0][o0-t0+j]+=d.L[k]*g;out[1][o0-t0+j]+=d.R[k]*g;}
  }else{
   const d=await src.read(c.s+(o0-s),m);
   for(let j=0;j<m;j++){const g=gainAt(P,i,o0-s+j,D);out[0][o0-t0+j]+=d.L[j]*g;out[1][o0-t0+j]+=d.R[j]*g;}
  }
 }
 // 声道模式（仅作用于主轨，支持 KTV 左右声道原唱/伴奏剥离）
 const mode=P.chMode||'stereo';
 if(mode==='left'){for(let j=0;j<n;j++)out[1][j]=out[0][j];}
 else if(mode==='right'){for(let j=0;j<n;j++)out[0][j]=out[1][j];}
 else if(mode==='mono'){for(let j=0;j<n;j++){const m=(out[0][j]+out[1][j])*0.5;out[0][j]=m;out[1][j]=m;}}
 // 双轨混音（伴奏/背景轨叠加 + 自动闪避 Auto-Ducking）
 if(P.bg&&P.bg.src&&P.sources[P.bg.src]){
  const bg=P.bg,bgSrc=P.sources[bg.src],bgGain=Number(bg.gain)||0;
  if(bgGain>0){
   const d=await readBg(bgSrc,t0-Math.round(bg.offset||0),n,!!bg.loop);
   if(bg.duck){
    const att=Math.exp(-1/(0.015*P.rate)),rel=Math.exp(-1/(0.08*P.rate)),th=0.025;
    const minG=Math.pow(10,clamp(Number(bg.duckDb ?? -10),-24,-2)/20);
    // 用片段前 256 个采样初始化包络，避免分段接缝处瞬态跳变
    let env=0,initN=Math.min(n,256);for(let j=0;j<initN;j++)env=Math.max(env,Math.max(Math.abs(out[0][j]),Math.abs(out[1][j])));
    let dg=env>th?minG:1;
    const gAtt=Math.exp(-1/(0.03*P.rate)),gRel=Math.exp(-1/(0.22*P.rate));
    for(let j=0;j<n;j++){
     const v=Math.max(Math.abs(out[0][j]),Math.abs(out[1][j]));
     env=v>env?att*env+(1-att)*v:rel*env+(1-rel)*v;
     const target=env>th?minG:1;
     dg=target<dg?gAtt*dg+(1-gAtt)*target:gRel*dg+(1-gRel)*target;
     const gg=bgGain*dg;
     out[0][j]+=d.L[j]*gg;out[1][j]+=d.R[j]*gg;
    }
   }else{
    for(let j=0;j<n;j++){out[0][j]+=d.L[j]*bgGain;out[1][j]+=d.R[j]*bgGain;}
   }
  }
 }
 return out;
}

// 波形：每列取片段峰值（导入时按 256 采样一桶预先计算）× 该处增益。
function columnPeaks(P,v0,spp,width){
 const out=new Float32Array(width),{st}=layout(P),D=Math.round(P.rate*DECLICK);
 for(let i=0;i<P.clips.length;i++){
  const c=P.clips[i];if(c.src==null)continue;const src=P.sources[c.src];if(!src?.peaks)continue;const s=st[i],L=len(c);
  const x0=Math.max(0,Math.floor((s-v0)/spp)),x1=Math.min(width-1,Math.ceil((s+L-v0)/spp));
  for(let x=x0;x<=x1;x++){
   const a=Math.max(s,v0+x*spp),b=Math.min(s+L,v0+(x+1)*spp);if(b<=a)continue;
   const r0=c.rev?(c.e-(b-s)):(c.s+a-s),r1=c.rev?(c.e-(a-s)-1):(c.s+b-s-1);
   const b0=clamp(Math.floor(r0/BUCKET),0,src.peaks.length-1),b1=clamp(Math.floor(r1/BUCKET),0,src.peaks.length-1);
   let pk=0;for(let k=b0;k<=b1;k++)if(src.peaks[k]>pk)pk=src.peaks[k];
   const g=Math.abs(gainAt(P,i,Math.min(L-1,Math.max(0,Math.round((a+b)/2-s))),D));const v=pk*g;if(v>out[x])out[x]=v;
  }
 }
 return out;
}

function bgColumnPeaks(P,v0,spp,width){
 if(!P.bg||!P.bg.src||!P.sources[P.bg.src]?.peaks)return null;
 const bg=P.bg,src=P.sources[bg.src],F=src.frames,off=Math.round(bg.offset||0),g=Number(bg.gain)||0;
 if(!F||g<=0)return null;
 const out=new Float32Array(width);
 for(let x=0;x<width;x++){
  const tA=Math.floor(v0+x*spp)-off,tB=Math.ceil(v0+(x+1)*spp)-off;
  if(!bg.loop&&(tB<=0||tA>=F))continue;
  const s0=bg.loop?(((tA%F)+F)%F):clamp(tA,0,F-1);
  const span=Math.min(F,Math.max(1,tB-tA));
  const b0=Math.floor(s0/BUCKET),bCount=Math.max(1,Math.ceil(span/BUCKET));
  let pk=0;for(let k=0;k<bCount&&k<32;k++){const idx=(b0+k)%src.peaks.length;if(src.peaks[idx]>pk)pk=src.peaks[idx];}
  out[x]=Math.min(1,pk*g);
 }
 return out;
}

async function peakOf(P,a,b,opt={}){let pk=0;const CH=P.rate*10;for(let t=a;t<b;t+=CH){if(opt.cancelled?.())throw Error('已取消');const d=await renderRange(P,t,Math.min(CH,b-t));for(const ch of d)for(const v of ch){const x=Math.abs(v);if(x>pk)pk=x;}}return pk;}
async function rmsOf(P,a,b,opt={}){
 let sq=0,cnt=0;const CH=P.rate*10;
 for(let t=a;t<b;t+=CH){
  if(opt.cancelled?.())throw Error('已取消');
  const d=await renderRange(P,t,Math.min(CH,b-t)),n=d[0].length;
  for(let i=0;i<n;i++)sq+=(d[0][i]*d[0][i]+d[1][i]*d[1][i])*0.5;
  cnt+=n;
 }
 return cnt?Math.sqrt(sq/cnt):0;
}
async function snapZero(P,t){const w=Math.round(P.rate*0.01),a=Math.max(0,t-w),T=total(P),n=Math.min(T,t+w)-a;if(n<4)return t;const d=await renderRange(P,a,n);const m=i=>d[0][i]+d[1][i];let best=t,bd=Infinity;for(let i=1;i<n;i++){if((m(i-1)<=0&&m(i)>0)||(m(i-1)>=0&&m(i)<0)){const p=a+i,dd=Math.abs(p-t);if(dd<bd){bd=dd;best=p;}}}return best;}

// ---------- 静音检测（去头尾静音 & 按静音自动打分割标记，基于峰值桶毫秒级完成） ----------
function peakTimeline(P){
 const T=total(P);if(!T)return {bins:new Float32Array(0),step:BUCKET,total:0};
 const n=Math.ceil(T/BUCKET),bins=columnPeaks(P,0,BUCKET,n);
 return {bins,step:BUCKET,total:T};
}
function findTrimBounds(P,threshDb=-45,padSec=0.05){
 const {bins,step,total:T}=peakTimeline(P);if(!T)return null;
 const th=Math.pow(10,threshDb/20),pad=Math.round(padSec*P.rate);
 let first=-1,last=-1;
 for(let i=0;i<bins.length;i++){if(bins[i]>=th){first=i;break;}}
 if(first<0)return null;
 for(let i=bins.length-1;i>=first;i--){if(bins[i]>=th){last=i;break;}}
 const a=clamp(first*step-pad,0,T),b=clamp((last+1)*step+pad,a,T);
 return {a,b,trimmedHead:a,trimmedTail:T-b};
}
function findSilenceGaps(P,threshDb=-45,minGapSec=1.5){
 const {bins,step,total:T}=peakTimeline(P);if(!T)return [];
 const th=Math.pow(10,threshDb/20),minBins=Math.max(1,Math.round(minGapSec*P.rate/step));
 // 先找到有效音频的起止范围，避免在首尾空白打标
 let first=-1,last=-1;
 for(let i=0;i<bins.length;i++)if(bins[i]>=th){first=i;break;}
 if(first<0)return [];
 for(let i=bins.length-1;i>=first;i--)if(bins[i]>=th){last=i;break;}
 const cuts=[];let runStart=-1;
 for(let i=first;i<=last;i++){
  if(bins[i]<th){if(runStart<0)runStart=i;}
  else{
   if(runStart>=0&&i-runStart>=minBins){
    const mid=Math.round(((runStart+i)/2)*step);
    if(mid>0&&mid<T)cuts.push(mid);
   }
   runStart=-1;
  }
 }
 return cuts;
}

// ---------- 预备拍（节拍器倒计时）纯数学合成 ----------
function synthCountIn(rate,beats=4,bpm=100){
 beats=clamp(Math.round(Number(beats)||4),1,16);
 bpm=clamp(Number(bpm)||100,40,240);
 const spb=Math.round(rate*60/bpm),totalN=spb*beats;
 const L=new Float32Array(totalN),R=new Float32Array(totalN);
 const clickLen=Math.min(spb,Math.round(rate*0.06));
 for(let b=0;b<beats;b++){
  const strong=(b%4===0),f0=strong?1320:880,amp=strong?0.72:0.46,tau=strong?0.018:0.015;
  const base=b*spb;
  for(let i=0;i<clickLen;i++){
   const t=i/rate,env=Math.exp(-t/tau)*(i<12?i/12:1);
   const sig=(Math.sin(2*Math.PI*f0*t)+0.25*Math.sin(2*Math.PI*f0*2*t))*env*amp;
   L[base+i]=sig;R[base+i]=sig;
  }
 }
 return {L,R,frames:totalN,beats,bpm};
}


// ---------- 独立专业升降调引擎（立体声相位锁定 IPL Phase Vocoder + 共振峰保护 + 三次埃尔米特重采样） ----------
const PV_N=2048,PV_HALF=PV_N>>1;
const PV_WIN=new Float32Array(PV_N),PV_REV=new Uint16Array(PV_N),PV_COS=new Float32Array(PV_HALF),PV_SIN=new Float32Array(PV_HALF);
for(let i=0;i<PV_N;i++){
 PV_WIN[i]=0.5*(1-Math.cos(2*Math.PI*i/PV_N));
 let x=i,r=0;for(let b=0;b<11;b++){r=(r<<1)|(x&1);x>>=1;}PV_REV[i]=r;
}
for(let i=0;i<PV_HALF;i++){const a=-2*Math.PI*i/PV_N;PV_COS[i]=Math.cos(a);PV_SIN[i]=Math.sin(a);}
function pvFft(re,im,inv){
 for(let i=0;i<PV_N;i++){const j=PV_REV[i];if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
 for(let len=2;len<=PV_N;len<<=1){
  const h=len>>1,step=PV_N/len,sgn=inv?-1:1;
  for(let i=0;i<PV_N;i+=len){
   for(let k=0;k<h;k++){
    const idx=k*step,wr=PV_COS[idx],wi=PV_SIN[idx]*sgn;
    const p=i+k,q=p+h,tr=re[q]*wr-im[q]*wi,ti=re[q]*wi+im[q]*wr;
    re[q]=re[p]-tr;im[q]=im[p]-ti;re[p]+=tr;im[p]+=ti;
   }
  }
 }
 if(inv){const s=1/PV_N;for(let i=0;i<PV_N;i++){re[i]*=s;im[i]*=s;}}
}
function wrapPi(a){a=(a+Math.PI)%(2*Math.PI);return a<0?a+Math.PI:a-Math.PI;}
function hermite4(y0,y1,y2,y3,t){
 const c0=y1,c1=0.5*(y2-y0),c2=y0-2.5*y1+2*y2-0.5*y3,c3=0.5*(y3-y0)+1.5*(y1-y2);
 return ((c3*t+c2)*t+c1)*t+c0;
}
function smoothLogEnv(mag,out){
 const W=6;
 for(let k=0;k<=PV_HALF;k++){
  let s=0,c=0;const a=Math.max(0,k-W),b=Math.min(PV_HALF,k+W);
  for(let j=a;j<=b;j++){s+=Math.log(mag[j]+1e-6);c++;}
  out[k]=s/c;
 }
 const tmp=Float32Array.from(out);
 for(let k=0;k<=PV_HALF;k++){
  let s=0,c=0;const a=Math.max(0,k-W),b=Math.min(PV_HALF,k+W);
  for(let j=a;j<=b;j++){s+=tmp[j];c++;}
  out[k]=s/c;
 }
}
function createProPitchEngine(rate,opt={}){
 const semitones=clamp(Number(opt.semitones)||0,-12,12);
 const tempo=clamp(Number(opt.tempo)||1,0.5,1.5);
 const formant=opt.formant!==false;
 const pitchRatio=Math.pow(2,semitones/12);
 const stretchRatio=pitchRatio/tempo;
 const hopS=clamp(Math.round(512*Math.min(1,stretchRatio)),128,512);
 const anaStep=hopS/stretchRatio;
 // 输入队列（前面补 PV_HALF 个零，使第 0 帧中心精确对齐采样 0，实现零延迟）
 let inL=new Float32Array(PV_HALF),inR=new Float32Array(PV_HALF),inLen=PV_HALF,inBase=0,inputN=0;
 let anaPos=0,prevAna=0,hasPrev=false,finished=false;
 const reL=new Float32Array(PV_N),imL=new Float32Array(PV_N),reR=new Float32Array(PV_N),imR=new Float32Array(PV_N);
 const magL=new Float32Array(PV_HALF+1),phL=new Float32Array(PV_HALF+1),magR=new Float32Array(PV_HALF+1),phR=new Float32Array(PV_HALF+1),magM=new Float32Array(PV_HALF+1);
 const prevAnaPh=new Float32Array(PV_HALF+1),prevSynthPh=new Float32Array(PV_HALF+1),logEnv=new Float32Array(PV_HALF+1);
 const peaks=new Int32Array(PV_HALF+1),peakRot=new Float32Array(PV_HALF+1);
 const olaL=new Float32Array(PV_N+hopS),olaR=new Float32Array(PV_N+hopS),olaW=new Float32Array(PV_N+hopS);
 // 拉伸后送入三次埃尔米特重采样器的缓冲
 let stL=new Float32Array(4),stR=new Float32Array(4),stLen=2,stBase=-2; // 前置 2 采样便于 4 点插值
 let resPos=0,emitted=0;

 function ensureIn(addN){
  if(inLen+addN<=inL.length)return;
  const cap=Math.max(inL.length*2,inLen+addN);
  const nL=new Float32Array(cap),nR=new Float32Array(cap);
  nL.set(inL.subarray(0,inLen));nR.set(inR.subarray(0,inLen));
  inL=nL;inR=nR;
 }
 function compactIn(needStart){
  const drop=needStart-inBase;
  if(drop<=8192)return;
  inL.copyWithin(0,drop,inLen);inR.copyWithin(0,drop,inLen);
  inLen-=drop;inBase+=drop;
 }
 function appendStretched(sL,sR,n){
  if(stLen+n>stL.length){
   const cap=Math.max(stL.length*2,stLen+n);
   const nL=new Float32Array(cap),nR=new Float32Array(cap);
   nL.set(stL.subarray(0,stLen));nR.set(stR.subarray(0,stLen));
   stL=nL;stR=nR;
  }
  stL.set(sL.subarray(0,n),stLen);stR.set(sR.subarray(0,n),stLen);stLen+=n;
 }
 function processOneFrame(curAna){
  const off=curAna-inBase;
  for(let i=0;i<PV_N;i++){
   const w=PV_WIN[i];
   reL[i]=inL[off+i]*w;imL[i]=0;
   reR[i]=inR[off+i]*w;imR[i]=0;
  }
  pvFft(reL,imL,false);pvFft(reR,imR,false);
  for(let k=0;k<=PV_HALF;k++){
   const rl=reL[k],il=imL[k],rr=reR[k],ir=imR[k];
   const ml=Math.hypot(rl,il),mr=Math.hypot(rr,ir);
   magL[k]=ml;phL[k]=Math.atan2(il,rl);
   magR[k]=mr;phR[k]=Math.atan2(ir,rr);
   magM[k]=ml+mr;
  }
  // 共振峰保护：在移调重采样前把谱包络按目标频率反向校正
  if(formant&&Math.abs(semitones)>0.05){
   smoothLogEnv(magM,logEnv);
   for(let k=1;k<PV_HALF;k++){
    const fk=k*pitchRatio;
    if(fk>=PV_HALF){const att=Math.exp(clamp(-0.15*(fk-PV_HALF),-2,0));magL[k]*=att;magR[k]*=att;continue;}
    const i0=Math.floor(fk),fr=fk-i0,tLog=logEnv[i0]+(logEnv[Math.min(PV_HALF,i0+1)]-logEnv[i0])*fr;
    const g=Math.exp(clamp(tLog-logEnv[k],-1.35,1.35));
    magL[k]*=g;magR[k]*=g;
   }
  }
  const dHopA=curAna-prevAna;
  if(!hasPrev){
   for(let k=0;k<=PV_HALF;k++){
    const domPh=magL[k]>=magR[k]?phL[k]:phR[k];
    prevAnaPh[k]=domPh;prevSynthPh[k]=domPh;
   }
   hasPrev=true;
  }else{
   let pCount=0;
   for(let k=1;k<PV_HALF;k++){
    if(magM[k]>=magM[k-1]&&magM[k]>=magM[k+1]&&magM[k]>1e-10)peaks[pCount++]=k;
   }
   if(!pCount){peaks[0]=1;pCount=1;}
   const twoPiOverN=2*Math.PI/PV_N;
   for(let pi=0;pi<pCount;pi++){
    const p=peaks[pi];
    const domPh=magL[p]>=magR[p]?phL[p]:phR[p];
    const expD=twoPiOverN*p*dHopA;
    const dp=wrapPi(domPh-prevAnaPh[p]-expD);
    const trueW=dHopA>0?(expD+dp)/dHopA:(twoPiOverN*p);
    const newSynth=prevSynthPh[p]+trueW*hopS;
    peakRot[pi]=newSynth-domPh;
    prevSynthPh[p]=newSynth;
   }
   // Identity Phase Locking：每个频点跟随最近主峰旋转相同相位，锁定谐波与立体声相位差
   let pi=0;
   for(let k=0;k<=PV_HALF;k++){
    while(pi+1<pCount&&Math.abs(peaks[pi+1]-k)<Math.abs(peaks[pi]-k))pi++;
    const rot=peakRot[pi];
    const domPh=magL[k]>=magR[k]?phL[k]:phR[k];
    prevAnaPh[k]=domPh;
    if(k!==peaks[pi])prevSynthPh[k]=domPh+rot;
    const nPhL=phL[k]+rot,nPhR=phR[k]+rot;
    reL[k]=magL[k]*Math.cos(nPhL);imL[k]=magL[k]*Math.sin(nPhL);
    reR[k]=magR[k]*Math.cos(nPhR);imR[k]=magR[k]*Math.sin(nPhR);
   }
  }
  prevAna=curAna;
  // 共轭对称还原实信号
  imL[0]=0;imR[0]=0;imL[PV_HALF]=0;imR[PV_HALF]=0;
  for(let k=1;k<PV_HALF;k++){
   reL[PV_N-k]=reL[k];imL[PV_N-k]=-imL[k];
   reR[PV_N-k]=reR[k];imR[PV_N-k]=-imR[k];
  }
  pvFft(reL,imL,true);pvFft(reR,imR,true);
  for(let i=0;i<PV_N;i++){
   const w=PV_WIN[i];
   olaL[i]+=reL[i]*w;olaR[i]+=reR[i]*w;olaW[i]+=w*w;
  }
  const outL=new Float32Array(hopS),outR=new Float32Array(hopS);
  for(let i=0;i<hopS;i++){
   const invW=olaW[i]>1e-6?1/olaW[i]:0;
   outL[i]=olaL[i]*invW;outR[i]=olaR[i]*invW;
  }
  olaL.copyWithin(0,hopS,PV_N);olaR.copyWithin(0,hopS,PV_N);olaW.copyWithin(0,hopS,PV_N);
  olaL.fill(0,PV_N-hopS);olaR.fill(0,PV_N-hopS);olaW.fill(0,PV_N-hopS);
  appendStretched(outL,outR,hopS);
 }
 function drainResampler(maxOut){
  const availEnd=stBase+stLen-2;
  let count=0;
  if(resPos+1<availEnd){
   count=Math.floor((availEnd-1-resPos)/pitchRatio)+1;
   if(maxOut!=null)count=Math.min(count,maxOut);
  }
  if(count<=0)return [new Float32Array(0),new Float32Array(0)];
  const oL=new Float32Array(count),oR=new Float32Array(count);
  for(let i=0;i<count;i++){
   const p=resPos-stBase,i1=Math.floor(p),frac=p-i1;
   oL[i]=hermite4(stL[i1-1],stL[i1],stL[i1+1],stL[i1+2],frac);
   oR[i]=hermite4(stR[i1-1],stR[i1],stR[i1+1],stR[i1+2],frac);
   resPos+=pitchRatio;
  }
  emitted+=count;
  const keepFrom=Math.floor(resPos)-2;
  const drop=keepFrom-stBase;
  if(drop>8192){stL.copyWithin(0,drop,stLen);stR.copyWithin(0,drop,stLen);stLen-=drop;stBase+=drop;}
  return [oL,oR];
 }
 return {
  rate,semitones,tempo,formant,
  push(L,R){
   if(finished)throw Error('移调引擎已结束');
   const n=L.length;inputN+=n;ensureIn(n);
   inL.set(L,inLen);inR.set(R,inLen);inLen+=n;
   while(Math.round(anaPos)+PV_N<=inBase+inLen){
    processOneFrame(Math.round(anaPos));
    anaPos+=anaStep;
   }
   compactIn(Math.round(anaPos));
   return drainResampler(null);
  },
  finish(){
   if(finished)throw Error('移调引擎已结束');
   finished=true;
   const targetOut=Math.round(inputN/tempo);
   const pad=PV_N*2;ensureIn(pad);
   inL.fill(0,inLen,inLen+pad);inR.fill(0,inLen,inLen+pad);inLen+=pad;
   const needStretched=(targetOut+4)*pitchRatio;
   let guard=0;
   while(stBase+stLen<needStretched&&guard++<2048){
    if(Math.round(anaPos)+PV_N>inBase+inLen){ensureIn(PV_N);inL.fill(0,inLen,inLen+PV_N);inR.fill(0,inLen,inLen+PV_N);inLen+=PV_N;}
    processOneFrame(Math.round(anaPos));
    anaPos+=anaStep;
   }
   const rem=Math.max(0,targetOut-emitted);
   return drainResampler(rem);
  }
 };
}

// ---------- 变速不变调（官方 Signalsmith Stretch 1.3.2 WASM 流式适配器） ----------
let stretchFactoryPromise=null,stretchWasmPromise=null;
async function ensureStretchAssets(){
 if(!global.SignalsmithWasmFactory){
  if(!stretchFactoryPromise){
   stretchFactoryPromise=new Promise((resolve,reject)=>{
    if(typeof document==='undefined')return reject(Error('当前环境无法动态加载变速引擎'));
    const s=document.createElement('script');s.src='/vendor/signalsmith-stretch-1.3.2/engine-factory.js?v=v31260';
    s.onload=()=>global.SignalsmithWasmFactory?resolve(global.SignalsmithWasmFactory):reject(Error('变速引擎加载失败'));
    s.onerror=()=>reject(Error('变速引擎脚本下载失败'));
    document.head.appendChild(s);
   });
  }
  await stretchFactoryPromise;
 }
 if(!stretchWasmPromise){
  stretchWasmPromise=fetch('/vendor/signalsmith-stretch-1.3.2/stretch.wasm?v=v31259').then(r=>{
   if(!r.ok)throw Error('Signalsmith WASM 加载失败（'+r.status+'）');
   return r.arrayBuffer();
  }).then(b=>new Uint8Array(b));
 }
 return {Factory:global.SignalsmithWasmFactory,binary:await stretchWasmPromise};
}

async function createTempoStretcher(rate,tempo,opt={}){
 tempo=clamp(Number(tempo)||1,0.5,1.5);
 const Factory=opt.Factory||(await ensureStretchAssets()).Factory;
 const binary=opt.binary||(await ensureStretchAssets()).binary;
 const m=await Factory({wasmBinary:binary});
 m._main();m._presetDefault(2,rate);m._setTransposeSemitones(0,8000/rate);m._setFormantSemitones(0,false);m._setFormantBase(0);
 const IN_BLOCK=1024,BUF=2048; // 0.5x 时 1024 输入产生 2048 输出，安全不越界
 const ptr=m._setBuffers(2,BUF);
 const inLat=m._inputLatency(),outLat=m._outputLatency();
 const skipTotal=Math.round(inLat/tempo)+outLat;
 const pending=[new Float32Array(IN_BLOCK),new Float32Array(IN_BLOCK)];
 let fill=0,inputN=0,rawOut=0,released=0,outAcc=0,outGen=0,finished=false;
 function stepFrame(ch){
  outAcc+=IN_BLOCK/tempo;
  const outN=clamp(Math.round(outAcc-outGen),1,BUF);
  outGen+=outN;
  let mem=m.HEAP8.buffer;
  new Float32Array(mem,ptr,BUF).set(ch[0]);
  new Float32Array(mem,ptr+BUF*4,BUF).set(ch[1]);
  m._process(IN_BLOCK,outN);
  mem=m.HEAP8.buffer;
  const skip=Math.min(outN,Math.max(0,skipTotal-rawOut));
  rawOut+=outN;
  const avail=outN-skip;
  if(avail<=0)return null;
  const sL=new Float32Array(mem,ptr+2*BUF*4,BUF),sR=new Float32Array(mem,ptr+3*BUF*4,BUF);
  const oL=new Float32Array(avail),oR=new Float32Array(avail);
  for(let i=0;i<avail;i++){
   const l=sL[skip+i],r=sR[skip+i];
   if(!Number.isFinite(l)||!Number.isFinite(r))throw Error('变速引擎输出异常');
   oL[i]=l;oR[i]=r;
  }
  released+=avail;
  return [oL,oR];
 }
 function join(parts){
  const n=parts.reduce((s,x)=>s+x[0].length,0);
  const L=new Float32Array(n),R=new Float32Array(n);let p=0;
  for(const x of parts){L.set(x[0],p);R.set(x[1],p);p+=x[0].length;}
  return [L,R];
 }
 return {
  rate,tempo,
  push(L,R){
   if(finished)throw Error('变速引擎已结束');
   const n=L.length;inputN+=n;const parts=[];
   for(let p=0;p<n;){
    const k=Math.min(IN_BLOCK-fill,n-p);
    pending[0].set(L.subarray(p,p+k),fill);pending[1].set(R.subarray(p,p+k),fill);
    p+=k;fill+=k;
    if(fill===IN_BLOCK){const out=stepFrame(pending);if(out)parts.push(out);fill=0;}
   }
   return join(parts);
  },
  finish(){
   if(finished)throw Error('变速引擎已结束');
   finished=true;
   const targetOut=Math.round(inputN/tempo),parts=[];
   if(fill){pending[0].fill(0,fill);pending[1].fill(0,fill);const out=stepFrame(pending);if(out)parts.push(out);fill=0;}
   pending[0].fill(0);pending[1].fill(0);
   let guard=0;
   while(released<targetOut&&guard++<64){const out=stepFrame(pending);if(out)parts.push(out);}
   const res=join(parts);
   if(res[0].length>Math.max(0,targetOut-(released-res[0].length))){
    const keep=Math.max(0,res[0].length-(released-targetOut));
    return [res[0].subarray(0,keep),res[1].subarray(0,keep)];
   }
   return res;
  }
 };
}

// ---------- OPFS 源文件 ----------
const knee=Math.pow(10,-1.5/20),ceil=0.98;
const soft=v=>{const a=Math.abs(v);return a<=knee?v:Math.sign(v)*(knee+(ceil-knee)*Math.tanh((a-knee)/(ceil-knee)));};
function wavHeader(rate,channels,bytes){const b=new ArrayBuffer(44),v=new DataView(b),w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};w(0,'RIFF');v.setUint32(4,36+bytes,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,rate,true);v.setUint32(28,rate*channels*2,true);v.setUint16(32,channels*2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,bytes,true);return b;}
function pcm(L,R,limit){const n=L.length,b=new ArrayBuffer(n*4),v=new DataView(b);for(let i=0;i<n;i++){let l=L[i],r=R[i];if(limit){l=soft(l);r=soft(r);}l=clamp(l,-1,1);r=clamp(r,-1,1);v.setInt16(i*4,l<0?Math.round(l*32768):Math.round(l*32767),true);v.setInt16(i*4+2,r<0?Math.round(r*32768):Math.round(r*32767),true);}return b;}
function opfsSource(id,name,file,frames,peaks,opfs){
 return {id,name,file,frames,peaks,opfs,async read(s,n){const a=clamp(s,0,frames),b=clamp(s+n,0,frames),L=new Float32Array(n),R=new Float32Array(n);if(b>a){const buf=await file.slice(44+a*4,44+b*4).arrayBuffer(),x=new Int16Array(buf);for(let i=0,o=a-s;i<x.length/2;i++,o++){L[o]=x[2*i]/32768;R[o]=x[2*i+1]/32768;}}return {L,R};}};
}
let uid=0;

async function importPCM(P,label,L,R){
 if(!navigator.storage?.getDirectory)throw Error('当前浏览器不支持 OPFS 临时文件存储');
 const folder=await navigator.storage.getDirectory(),name='edit147-src-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.wav',handle=await folder.getFileHandle(name,{create:true}),writer=await handle.createWritable();
 let closed=false;
 try{
  const peaks=[];let bk=0,bc=0;
  for(let i=0;i<L.length;i++){const a=Math.max(Math.abs(L[i]),Math.abs(R[i]));if(a>bk)bk=a;if(++bc===BUCKET){peaks.push(bk);bk=0;bc=0;}}
  if(bc)peaks.push(bk);
  const data=pcm(L,R,false);
  await writer.write(new Blob([wavHeader(P.rate,2,data.byteLength),data]));
  await writer.close();closed=true;
  const f=await handle.getFile(),id='s'+(++uid)+'-'+Date.now().toString(36);
  P.sources[id]=opfsSource(id,label||'音频',f,L.length,Float32Array.from(peaks),name);
  return P.sources[id];
 }catch(e){try{if(!closed)await writer.abort()}catch(_){}try{await folder.removeEntry(name)}catch(_){}throw e;}
}

async function resampleBuffer(audio,targetRate){
 if(audio.sampleRate===targetRate)return audio;
 const lenOut=Math.max(1,Math.round(audio.duration*targetRate));
 const OC=global.OfflineAudioContext||global.webkitOfflineAudioContext;
 if(!OC)throw Error('采样率不一致且当前浏览器不支持重采样');
 const off=new OC(Math.min(2,audio.numberOfChannels),lenOut,targetRate);
 const src=off.createBufferSource();src.buffer=audio;src.connect(off.destination);src.start(0);
 return await off.startRendering();
}

async function importFile(P,file,opt={}){
 if(!navigator.storage?.getDirectory)throw Error('当前浏览器不支持 OPFS 临时文件存储');
 const abort=()=>!!opt.cancelled?.();
 const fname=String(file.name||'').toLowerCase();
 const isMp3=/\.mp3$/.test(fname)||file.type==='audio/mpeg';
 const isWav=/\.wav$/.test(fname)||/wav/.test(file.type||'');
 const useStream=(isMp3||isWav)&&!!global.SongEQ146?.decoded;
 const folder=await navigator.storage.getDirectory(),name='edit147-src-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.wav',handle=await folder.getFileHandle(name,{create:true}),writer=await handle.createWritable();
 const hasExisting=Object.keys(P.sources).length>0||P.clips.length>0;
 const ctx=new (global.AudioContext||global.webkitAudioContext)({sampleRate:P.rate});
 let bytes=0,frames=0,closed=false,rate=0;const peaks=[];let bk=0,bc=0;
 try{
  await writer.write(new Uint8Array(44));
  if(useStream){
   for await(const d of global.SongEQ146.decoded(file,ctx,abort)){
    if(!rate){rate=d.rate;if(!hasExisting)P.rate=rate;else if(rate!==P.rate)throw Error('采样率与已打开的音频不一致');}
    opt.onProgress?.(Math.min(99,Math.round(d.percent*100)));
    const L=d.ch[0],R=d.ch[1]||L;for(let i=0;i<L.length;i++){const a=Math.max(Math.abs(L[i]),Math.abs(R[i]));if(a>bk)bk=a;if(++bc===BUCKET){peaks.push(bk);bk=0;bc=0;}}
    const data=pcm(L,R,false);await writer.seek(44+bytes);await writer.write(new Blob([data]));bytes+=data.byteLength;frames+=L.length;
    await new Promise(r=>setTimeout(r,0));
   }
  }else{
   // 兼容 M4A / OGG / WebM / AAC / 录音 Blob 直接导入
   if(file.size>60*1048576)throw Error('M4A/OGG 等格式直接导入上限为 60 MB，超大文件请先转为 MP3');
   opt.onProgress?.(10);
   const raw=await file.arrayBuffer();if(abort())throw Error('已取消');
   let audio=await ctx.decodeAudioData(raw.slice(0));if(abort())throw Error('已取消');
   if(!hasExisting)P.rate=audio.sampleRate;
   else if(audio.sampleRate!==P.rate)audio=await resampleBuffer(audio,P.rate);
   const L0=audio.getChannelData(0),R0=audio.numberOfChannels>1?audio.getChannelData(1):L0,CH=P.rate*10;
   for(let pos=0;pos<L0.length;pos+=CH){
    if(abort())throw Error('已取消');
    const L=L0.subarray(pos,Math.min(L0.length,pos+CH)),R=R0.subarray(pos,Math.min(R0.length,pos+CH));
    for(let i=0;i<L.length;i++){const a=Math.max(Math.abs(L[i]),Math.abs(R[i]));if(a>bk)bk=a;if(++bc===BUCKET){peaks.push(bk);bk=0;bc=0;}}
    const data=pcm(L,R,false);await writer.seek(44+bytes);await writer.write(new Blob([data]));bytes+=data.byteLength;frames+=L.length;
    opt.onProgress?.(Math.min(99,20+Math.round((pos+L.length)/L0.length*79)));
    await new Promise(r=>setTimeout(r,0));
   }
  }
  if(bc)peaks.push(bk);if(!frames)throw Error('没有解码出音频');
  await writer.truncate(bytes+44);await writer.seek(0);await writer.write(new Blob([wavHeader(P.rate,2,bytes)]));await writer.close();closed=true;
  const f=await handle.getFile(),id='s'+(++uid)+'-'+Date.now().toString(36);
  P.sources[id]=opfsSource(id,file.name||'音频',f,frames,Float32Array.from(peaks),name);return P.sources[id];
 }catch(e){try{if(!closed)await writer.abort()}catch(_){}try{await folder.removeEntry(name)}catch(_){}throw e;}
 finally{try{await ctx.close()}catch(_){}}
}

async function exportRange(P,a,b,opt={}){
 const folder=await navigator.storage.getDirectory(),name='edit147-out-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.wav',handle=await folder.getFileHandle(name,{create:true}),writer=await handle.createWritable();
 let bytes=0,closed=false;const CH=P.rate*8,tempo=clamp(Number(P.tempo)||1,0.5,1.5),pitch=clamp(Number(P.pitch)||0,-12,12),usePitch=Math.abs(pitch)>1e-4,useStretch=!usePitch&&Math.abs(tempo-1)>1e-4;
 try{
  await writer.write(new Uint8Array(44));
  const stretcher=usePitch?createProPitchEngine(P.rate,{semitones:pitch,tempo,formant:P.formant!==false}):(useStretch?await createTempoStretcher(P.rate,tempo):null);
  const dnProc=((P.denoise||0)>0&&global.SongEdit161Pro?.createDenoiseProcessor)?global.SongEdit161Pro.createDenoiseProcessor(P.rate,P.denoise):null;
  const compProc=(P.comp&&P.comp!=='off'&&global.SongEdit161Pro?.createCompressorProcessor)?global.SongEdit161Pro.createCompressorProcessor(P.rate,P.comp):null;
  const revProc=(P.reverb&&P.reverb!=='off'&&global.SongEdit161Pro?.createReverbProcessor)?global.SongEdit161Pro.createReverbProcessor(P.rate,P.reverb,P.reverbMix??1):null;
  for(let t=a;t<b;t+=CH){
   if(opt.cancelled?.())throw Error('已取消');
   let d=await renderRange(P,t,Math.min(CH,b-t));
   if(dnProc)d=dnProc.process(d[0],d[1]);
   if(compProc)d=compProc.process(d[0],d[1]);
   if(revProc)d=revProc.process(d[0],d[1]);
   const out=stretcher?stretcher.push(d[0],d[1]):d;
   if(out[0].length){const data=pcm(out[0],out[1],true);await writer.seek(44+bytes);await writer.write(new Blob([data]));bytes+=data.byteLength;}
   opt.onProgress?.(Math.min(98,Math.round((t-a+Math.min(CH,b-t))/(b-a)*100)));
   await new Promise(r=>setTimeout(r,0));
  }
  if(stretcher){
   const tail=stretcher.finish();
   if(tail[0].length){const data=pcm(tail[0],tail[1],true);await writer.seek(44+bytes);await writer.write(new Blob([data]));bytes+=data.byteLength;}
  }
  await writer.truncate(bytes+44);await writer.seek(0);await writer.write(new Blob([wavHeader(P.rate,2,bytes)]));await writer.close();closed=true;
  opt.onProgress?.(100);
  return {file:await handle.getFile(),opfs:name};
 }catch(e){try{if(!closed)await writer.abort()}catch(_){}try{await folder.removeEntry(name)}catch(_){}throw e;}
}
async function removeOPFS(name){try{const f=await navigator.storage.getDirectory();await f.removeEntry(name);}catch(_){}}

// ---------- 图形界面 ----------
const S={P:project(),sel:null,ph:0,v0:0,spp:0,undo:[],redo:[],board:null,snap:true,loop:false,tab:'guide',wiz:'vocal',busy:null,play:null,ctx:null,deps:null,host:null,urls:[],outs:[],ver:0,deep:null,raf:0,taps:[],rec:null,tuner:null,vidCover:null};
const LABELS=['前奏','主歌','副歌','间奏','桥段','尾奏','分割'];
const MCOLOR={'前奏':'#2f80ed','主歌':'#27ae60','副歌':'#eb5757','间奏':'#f2994a','桥段':'#9b51e0','尾奏':'#56627a','分割':'#8a8a8a'};
const fmt=n=>{const s=Math.max(0,n)/S.P.rate,m=Math.floor(s/60),r=s-m*60;return m+':'+(r<10?'0':'')+r.toFixed(2);};
const parseT=v=>{v=String(v).trim().replace('：',':');if(!v)return NaN;const p=v.split(':');const s=p.length>1?Number(p[0])*60+Number(p[1]):Number(p[0]);return Number.isFinite(s)?Math.round(s*S.P.rate):NaN;};
const q=s=>S.host?.querySelector(s);
const T=()=>total(S.P);
function snapshot(){return JSON.stringify({clips:S.P.clips,markers:S.P.markers,chMode:S.P.chMode||'stereo',tempo:S.P.tempo||1,pitch:S.P.pitch||0,formant:S.P.formant!==false,denoise:S.P.denoise||0,comp:S.P.comp||'off',reverb:S.P.reverb||'off',reverbMix:S.P.reverbMix??1,bg:S.P.bg||null});}
function liveEdit(fn,keepSel=true){
 const was=S.play?{end:S.play.end,loop:S.play.loop,sel:S.play.sel,a:S.play.a}:null;
 const curPh=S.ph;
 edit(fn,keepSel);
 const t=T();if(!t)return;
 if(was){
  const from=clamp(curPh,was.sel?was.a:0,Math.max(0,was.end-S.P.rate*0.05));
  startPlay(from,clamp(was.end,from+1,t),was.loop,was.sel);
 }else if(S.sel&&S.sel.b-S.sel.a>S.P.rate*0.05){
  startPlay(S.sel.a,S.sel.b,S.loop,true);
 }else{
  const from=curPh>=t-S.P.rate*0.05?0:curPh;
  startPlay(from,t,false,false);
 }
}
function edit(fn,keepSel,keepPlay=false){if(!keepPlay)stopPlay();S.undo.push(snapshot());if(S.undo.length>50)S.undo.shift();S.redo=[];fn();S.ver++;const t=T();if(S.sel&&(!keepSel||S.sel.b>t))S.sel=keepSel&&S.sel.a<t?{a:S.sel.a,b:Math.min(S.sel.b,t)}:null;S.ph=clamp(S.ph,0,t);clampView();refresh();}
function restore(str){const o=JSON.parse(str);S.P.clips=o.clips;S.P.markers=o.markers;S.P.chMode=o.chMode||'stereo';S.P.tempo=o.tempo||1;S.P.pitch=o.pitch||0;S.P.formant=o.formant!==false;S.P.denoise=o.denoise||0;S.P.comp=o.comp||'off';S.P.reverb=o.reverb||'off';S.P.reverbMix=o.reverbMix??1;S.P.bg=o.bg||null;S.ver++;S.sel=null;S.ph=clamp(S.ph,0,T());clampView();refresh();}
function undo(){if(!S.undo.length)return;stopPlay();S.redo.push(snapshot());restore(S.undo.pop());status('已撤销');}
function redo(){if(!S.redo.length)return;stopPlay();S.undo.push(snapshot());restore(S.redo.pop());status('已重做');}
function status(t){const n=q('#e147Status');if(n)n.textContent=t;}
function width(){const c=q('#e147Main');return Math.max(100,c?.clientWidth||320);}
function fit(){const t=T();S.v0=0;S.spp=Math.max(1,t/width());}
function clampView(){const t=T(),w=width();if(!S.spp||!t){fit();return;}S.spp=clamp(S.spp,0.5,Math.max(1,t/w));S.v0=clamp(S.v0,0,Math.max(0,t-S.spp*w));}
function zoom(f,center){const w=width(),c=center??(S.sel?(S.sel.a+S.sel.b)/2:S.ph),x=(c-S.v0)/S.spp;S.spp=S.spp*f;clampView();S.v0=c-x*S.spp;clampView();draw();}
function needSel(){if(!S.sel||S.sel.b-S.sel.a<1){status('请先在波形上拖动选择一段（或点“全选”）');return false;}return true;}

function html(){
 return `<h3>✂️ 音频编辑 · V3.12.76 向导式专业旗舰版</h3>
 <p class="notice">本地非破坏式编辑，不上传服务器；支持 BPM/调性自动识别、智能人声降噪与录音棚混响、独立相位锁定升降调（含共振峰保护）、0.5×–1.5× 变速、双轨自动闪避、节拍器预备拍、一键批量处理打包 ZIP、实时录音插入与常用参数模板。可撤销 50 步。</p>
 <label class="field">打开音频（支持 MP3、WAV、M4A、OGG，可多选拼接）<input id="e147Open" type="file" multiple accept=".mp3,.wav,.m4a,.ogg,.webm,audio/*"></label>
 <div class="song147-bar"><span id="e147Info" class="sub"></span><span class="song147-ur"><button type="button" class="ghost small" data-e147="undo">↶ 撤销</button><button type="button" class="ghost small" data-e147="redo">↷ 重做</button></span></div>
 <canvas id="e147Over" class="song147-over" height="44"></canvas>
 <canvas id="e147Main" class="song147-main" height="170"></canvas>
 <div class="btns song147-zoom"><button type="button" class="ghost small" data-e147="zin">＋ 放大</button><button type="button" class="ghost small" data-e147="zout">－ 缩小</button><button type="button" class="ghost small" data-e147="zfit">视野全曲</button><button type="button" class="ghost small" data-e147="zsel">看选区</button><button type="button" class="btn-mint small" data-e147="selall">☑ 选定全曲</button><button type="button" class="ghost small" data-e147="selnone">取消选区</button></div>
 <div class="song147-times">
  <label>起点<input id="e147A" inputmode="decimal" placeholder="0:00.00"><span class="song147-nudge"><button type="button" class="ghost small" data-e147="anudge-">-0.05s</button><button type="button" class="ghost small" data-e147="anudge+">+0.05s</button></span></label>
  <label>终点<input id="e147B" inputmode="decimal" placeholder="0:00.00"><span class="song147-nudge"><button type="button" class="ghost small" data-e147="bnudge-">-0.05s</button><button type="button" class="ghost small" data-e147="bnudge+">+0.05s</button></span></label>
  <label>长度<input id="e147L" inputmode="decimal" placeholder="—"></label>
  <label>播放位置<input id="e147P" inputmode="decimal"></label>
 </div>
 <div class="btns song147-transport"><button type="button" class="ghost" data-e147="home" aria-label="回到开头">⏮</button><button type="button" class="primary" data-e147="play" id="e147PlayBtn">▶ 播放</button><button type="button" class="btn-mint" data-e147="playsel">▶ 播放选区</button><button type="button" class="ghost" data-e147="loop" id="e147LoopBtn">🔁 循环：关</button></div>
 <div class="song115-tabs song147-tabs" role="tablist">${[['guide','🧭 小白向导'],['edit','① 剪辑'],['vol','② 分离 / 降噪 / 美化'],['mix','③ 调速 / 移调 / 混音'],['ins','④ 插入 / 录音'],['tuner','⑤ 音准 / 和弦'],['mark','⑥ 标记'],['batch','⑦ 批量'],['out','⑧ 导出 / 视频']].map(([k,v])=>`<button type="button" class="ghost small" data-e147-tab="${k}">${v}</button>`).join('')}</div>
 <div id="e147Panel" class="song147-panel"></div>
 <progress id="e147Progress" max="100" value="0" style="width:100%"></progress><p id="e147Status" class="song115-status" role="status"></p><div id="e147Result"></div>`;
}

function panel(){
 const t=S.tab,P=S.P;let h='';
 if(t==='guide'){
  const w=S.wiz||'vocal';
  const SCENES={
   vocal:{
    title:'手机清唱 / 艺考录音 → 变专业成品',
    tip:'最常见流程：先去杂音空白，再一键套用录音棚母带链，最后统一响度导出。',
    steps:[
     {t:'去除开头/结尾多余静音',d:'删掉刚按下录音和结束时的空白杂音',btn:'一键去静音',act:'trimSil'},
     {t:'一键美化人声（降噪 + 压缩 + 混响）',d:'小白直接点右侧一键生效，不需懂专业参数',btn:'手机清唱变录音棚',act:'chain',v:'studio'},
     {t:'统一全曲响度（-16 LUFS）',d:'让声音饱满清晰，发微信/交作业音量一致',btn:'去调响度 →',go:'vol'},
     {t:'导出 MP3 / WAV 或生成波形视频',d:'支持直接合成抖音/小红书动态波形短视频',btn:'去导出 →',go:'out'}
    ]
   },
   karaoke:{
    title:'原唱歌曲 → 做纯净伴奏（去原唱 + 升降调 + 慢练）',
    tip:'适合练唱、考级或演出制作专属调性伴奏。',
    steps:[
     {t:'用本机加速 AI 拆出伴奏与人声',d:'选 MDX Inst HQ3 分离完成后，点「切换为纯净伴奏轨」',btn:'去 AI 分离 →',go:'vol'},
     {t:'测原曲调性 & 调整升降调/倍速',d:'自动识别原调与 BPM，实时换算目标调性并试听',btn:'去调速/移调 →',go:'mix'},
     {t:'（可选）开头插入 4 拍预备拍',d:'一键同步 BPM，开头加上节拍器倒计时更好进拍',btn:'去插预备拍 →',go:'ins'},
     {t:'导出成品伴奏',d:'支持 MP3 192k/320k 或无损 WAV',btn:'去导出 →',go:'out'}
    ]
   },
   remix:{
    title:'老歌精修（只给人声加混响 / 调人声伴奏比例）',
    tip:'把人声和伴奏拆成主轨+背景轨，互不干扰单独精修。',
    steps:[
     {t:'AI 分离出人声与伴奏',d:'在「② 分离 / 降噪 / 美化」运行本机加速 AI 分离',btn:'去 AI 分离 →',go:'vol'},
     {t:'挂载「人声主轨 + 伴奏背景轨」',d:'分离完成后点击「🎚 人声主轨 + 伴奏背景轨」',btn:'去挂载双轨 →',go:'vol'},
     {t:'单独给人声加美化混响，微调伴奏音量',d:'在「②」选流行板式/抒情混响，在「③」调背景伴奏 dB',btn:'去调混响 →',go:'vol'},
     {t:'导出精修成品',d:'自动合并双轨并柔和防削波导出',btn:'去导出 →',go:'out'}
    ]
   },
   voiceover:{
    title:'老师录制讲解 + 轻音乐背景自动闪避',
    tip:'说话时背景音乐自动压低，停顿时自然回升，像电台节目一样专业。',
    steps:[
     {t:'直接录音或导入讲解干声',d:'在「④ 插入 / 录音」点击麦克风即可录制插入',btn:'去录音/插入 →',go:'ins'},
     {t:'去头尾静音 + 开启轻度降噪',d:'先清理杂音，再叠加配乐更干净',btn:'去降噪 →',go:'vol'},
     {t:'导入背景轻音乐并开启「自动闪避」',d:'在「③ 调速 / 移调 / 混音」导入背景轨即可自动闪避',btn:'去加背景乐 →',go:'mix'},
     {t:'导出教学成品',d:'建议先做 -16 LUFS 响度标准化再导出 MP3',btn:'去导出 →',go:'out'}
    ]
   },
   batch:{
    title:'多首伴奏/教材一键批量处理打包 ZIP',
    tip:'适合琴行老师或自媒体，一次处理最多 30 首曲目。',
    steps:[
     {t:'进入「⑦ 批量」页签',d:'一次选择多首音频，统一勾选移调、响度、去静音、降噪混响',btn:'直达批量处理 →',go:'batch'}
    ]
   }
  };
  const cur=SCENES[w]||SCENES.vocal;
  h=`<div class="song147-subcard c-teal"><b>🧭 小白智能向导：选择你想做的事，按步骤点即可</b>
   <div class="btns">${[['vocal','🎤 清唱/艺考精修'],['karaoke','🎹 做伴奏/升降调'],['remix','🎚 单独给人声加混响'],['voiceover','🎙 讲解+配乐闪避'],['batch','📦 多曲批量打包']].map(([k,v])=>`<button type="button" class="${w===k?'btn-mint':'ghost'} small" data-e147="wiz" data-v="${k}">${v}</button>`).join('')}</div>
   <p class="sub"><b>${cur.title}</b> · ${cur.tip}</p>
   ${cur.steps.map((st,i)=>`<div class="song147-wiz-step"><span class="song147-wiz-num">${i+1}</span><div class="song147-wiz-body"><b>${st.t}</b><small>${st.d}</small></div><button type="button" class="btn-mint small" ${st.go?`data-e147="wizGo" data-v="${st.go}"`:`data-e147="${st.act}" ${st.v?`data-v="${st.v}"`:''}`}>${st.btn}</button></div>`).join('')}
   <p class="sub">💡 专业小贴士：上方页签 ①→⑧ 已严格按录音棚标准顺序排列（先剪辑 → 再分离/降噪/压缩/混响/响度 → 再调速移调 → 最后导出），从左到右操作最不容易出错。</p>
  </div>`;
 }else if(t==='edit'){
  h=`<div class="btns"><button type="button" class="ghost small" data-e147="selall">全选</button><button type="button" class="ghost small" data-e147="selnone">取消选择</button><button type="button" class="ghost small" data-e147="trimSil">✨ 一键去头尾静音</button></div>
  <div class="btns"><button type="button" class="btn-mint" data-e147="cut">✂ 剪切</button><button type="button" class="btn-mint" data-e147="copy">复制</button><button type="button" class="btn-mint" data-e147="paste">粘贴</button><button type="button" class="ghost" data-e147="del">删除选区</button><button type="button" class="ghost" data-e147="crop">只保留选区</button><button type="button" class="ghost" data-e147="rev">🔄 选区倒放</button><button type="button" class="ghost" data-e147="split">在播放位置分割</button></div>
  <label class="song146-dyn"><input type="checkbox" id="e147Snap" ${S.snap?'checked':''}><span><b>吸附过零点</b><small>选区两端自动移到最近的过零点（±10 ms），剪切处更干净；拼接点另有 4 ms 防爆音淡化</small></span></label>
  <p class="sub">粘贴：有选区时替换选区，没有选区时插入到播放位置。${S.board?'剪贴板：'+fmt(clipsLength(S.board)):'剪贴板为空'}</p>`;
 }else if(t==='vol'){
  const cm=P.chMode||'stereo',rm=Math.round((P.reverbMix??1)*100),hq3=P.hq3;
  h=`<div class="song147-subcard c-teal"><b>✨ 小白快捷：一键成品母带链（点一下自动完成 降噪→压缩→混响）</b>
   <div class="btns">
    <button type="button" class="btn-mint small" data-e147="chain" data-v="studio">📱 手机清唱变录音棚</button>
    <button type="button" class="ghost small" data-e147="chain" data-v="exam">🎓 艺考自然精修</button>
    <button type="button" class="ghost small" data-e147="chain" data-v="ballad">🎤 流行抒情大片</button>
    <button type="button" class="ghost small" data-e147="chain" data-v="dry">🔄 一键还原干声</button>
   </div>
   <p class="sub">不知道下面怎么调？直接点上面任意一键方案即可出大片，不满意再在下方按「第 1 步 → 第 5 步」精细微调。</p>
  </div>
  <div class="song147-subcard c-plum"><b>第 1 步 · ⚡ AI 人声分离（5 大 MDX 模型 · WebGPU / 多线程 Worker）</b>
   <div class="btns">
    <select id="e147Hq3Model">
     <option value="UVR-MDX-NET-Inst_HQ_3" selected>MDX Inst HQ3：伴奏优化 · 约67MB</option>
     <option value="UVR-MDX-NET-Voc_FT">MDX Vocal FT：全部人声·质量最好 · 约67MB</option>
     <option value="Kim_Vocal_2">Kim Vocal 2：全部人声·清唱对比 · 约67MB</option>
     <option value="UVR_MDXNET_KARA_2">MDX Karaoke：去主唱留和声 · 约53MB·手机最轻</option>
     <option value="UVR_MDXNET_Main">MDX Main：通用均衡 · 约67MB</option>
    </select>
    <select id="e147Hq3Q"><option value="standard" selected>标准（重叠25%·最快）</option><option value="fine">精细（重叠50%）</option><option value="best">最佳（+正反相降噪）</option></select>
    <button type="button" class="primary small" data-e147="runHq3">🚀 开始本机加速 AI 分离</button>
    <button type="button" class="ghost small" data-e147="cancel">取消</button>
   </div>
   ${hq3?`<div class="btns" style="margin-top:8px"><label class="song147-inline">单轨/打包下载格式 <select id="e147Hq3DlFmt"><option value="mp3-192" selected>MP3 192 kbps</option><option value="mp3-320">MP3 320 kbps</option><option value="wav">WAV 无损</option></select></label></div>
   <div class="song147-stemrow"><button type="button" class="btn-mint small" data-e147="hq3Inst">🎹 切换为纯净伴奏轨</button><button type="button" class="ghost small" data-e147="hq3DlInst">⬇ 下载伴奏</button></div>
   <div class="song147-stemrow"><button type="button" class="btn-mint small" data-e147="hq3Voc">🎤 切换为分离人声轨</button><button type="button" class="ghost small" data-e147="hq3DlVoc">⬇ 下载人声</button></div>
   <div class="btns">
    <button type="button" class="ghost small" data-e147="hq3Dual">🎚 人声主轨 + 伴奏背景轨（可单给主唱加混响）</button>
    <button type="button" class="ghost small" data-e147="hq3Zip">📦 打包下载人声+伴奏 ZIP</button>
   </div><p class="sub">✅ 分离双轨已加载进编辑器（${esc(hq3.info||'已完成')}），可直接点右侧下载 WAV/MP3，或点左侧切换主轨实时试听。</p>`
   :`<p class="sub">全程在后台 Worker 线程运行（优先调用手机/电脑 WebGPU，不支持则自动切 4 线程 WASM）。如需做伴奏或单独给人声加混响，请先做这一步。</p>`}
   <details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px;color:#793064">☁️ 备选：Modal 云端 GPU 分离（MDX Inst HQ3 / BS-RoFormer）</summary>
    <div class="btns" style="margin-top:6px">
     <select id="e147CloudModel"><option value="hq3" selected>MDX Inst HQ3</option><option value="bs_roformer">BS-RoFormer（旗舰）</option></select>
     <select id="e147CloudFmt"><option value="mp3" selected>MP3 192k</option><option value="wav">WAV 无损</option></select>
     <button type="button" class="ghost small" data-e147="runCloudStem">☁️ 使用云端 GPU 分离</button>
    </div>
   </details>
   <details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px;color:#793064">🎛 KTV 左右声道剥离（老式左右声道分轨伴奏专用）</summary>
    <div class="btns" style="margin-top:6px">${[['stereo','原立体声'],['left','只留左声道（双耳）'],['right','只留右声道（双耳）'],['mono','合并单声道']].map(([k,v])=>`<button type="button" class="${cm===k?'btn-mint':'ghost'} small" data-e147="chmode" data-v="${k}">${v}</button>`).join('')}</div>
   </details>
  </div>
  <div class="song147-subcard c-blue"><b>第 2 步 · 🎙 智能人声降噪（先去底噪，再压缩才不放大杂音）</b>
   <div class="btns">${[[0,'关'],[1,'轻度（空调/电流）'],[2,'中度（环境杂音）'],[3,'强力（嘈杂教室）']].map(([k,v])=>`<button type="button" class="${(P.denoise||0)===k?'btn-mint':'ghost'} small" data-e147="denoise" data-v="${k}">${v}</button>`).join('')}</div>
  </div>
  <div class="song147-subcard c-amber"><b>第 3 步 · 🎛 人声动态压缩器（压平忽大忽小、副歌不爆音）</b>
   <div class="btns">${[['off','关'],['gentle','轻度稳音（艺考）'],['vocal','流行人声紧实'],['master','母带饱满']].map(([k,v])=>`<button type="button" class="${(P.comp||'off')===k?'btn-mint':'ghost'} small" data-e147="comp" data-v="${k}">${v}</button>`).join('')}</div>
  </div>
  <div class="song147-subcard c-violet"><b>第 4 步 · 🏛 专业立体声美化混响（给干净平稳的人声加空间感）</b>
   <div class="btns">${[['off','关（干声）'],['studio','温暖录音棚'],['vocal','流行人声板式'],['recital','声乐小厅'],['ballad','抒情大片'],['hall','金色音乐厅'],['cathedral','空灵圣堂'],['ktv','专业 KTV 包厢'],['dream','梦幻宽广']].map(([k,v])=>`<button type="button" class="${(P.reverb||'off')===k?'btn-mint':'ghost'} small" data-e147="reverb" data-v="${k}">${v}</button>`).join('')}</div>
   <div class="song146-band"><span>混响浓度<small>自由微调尾音轻重</small></span><input id="e147RevMix" type="range" min="30" max="160" step="10" value="${rm}"><output id="e147RevMixOut">${rm}%</output></div>
  </div>
  <div class="song147-subcard c-green"><b>第 5 步 · 🔊 淡入淡出 &amp; 最终音量 / LUFS 响度标准化</b>
   <div class="btns"><button type="button" class="btn-mint small" data-e147="fin">淡入</button><button type="button" class="btn-mint small" data-e147="fout">淡出</button><button type="button" class="ghost small" data-e147="mute">静音选区</button></div>
   <div class="btns"><select id="e147Gain">${[-12,-6,-3,-1,1,3,6].map(v=>`<option value="${v}" ${v===3?'selected':''}>${v>0?'+':''}${v} dB</option>`).join('')}</select><button type="button" class="ghost small" data-e147="gain">调整选区音量</button></div>
   <div class="btns"><button type="button" class="ghost small" data-e147="norm">峰值标准化 (-1 dBFS)</button><button type="button" class="btn-mint small" data-e147="lufs16">响度标准化 (-16 LUFS 教学)</button><button type="button" class="ghost small" data-e147="lufs14">响度标准化 (-14 LUFS 演出)</button></div>
   <div class="btns" style="margin-top:8px;padding-top:8px;border-top:1px dashed #c5ebd1">
    <button type="button" class="ghost small" data-e147="undo" ${S.undo.length?'':'disabled'}>↶ 撤销上一步</button>
    <button type="button" class="ghost small" data-e147="redo" ${S.redo.length?'':'disabled'}>↷ 重做</button>
    <button type="button" class="ghost small" data-e147="resetVol">🔄 还原原始音量 / 淡入淡出</button>
   </div>
   <p class="sub">误操作可随时点「↶ 撤销上一步」退回；点「🔄 还原原始音量 / 淡入淡出」将选区（无选区时为整首）恢复为原始 0 dB 且清除淡入淡出，不影响剪辑与混响。</p>
  </div>`;
 }else if(t==='mix'){
  const tp=Number(P.tempo||1),stVal=Number(P.pitch||0),fm=P.formant!==false;
  const bg=P.bg,bgName=bg&&P.sources[bg.src]?P.sources[bg.src].name:'未加载';
  const bgDb=bg?Math.round(20*Math.log10(Math.max(0.01,bg.gain||0.35))): -9;
  const bgOff=bg?((bg.offset||0)/P.rate).toFixed(2):'0.00';
  const stTxt=stVal===0?'原调 (0)':(stVal>0?'+':'')+stVal+' 半音';
  const mt=P.meta,tgtKey=mt&&global.SongEdit161Pro?global.SongEdit161Pro.transposeKeyName(mt.root,mt.mode,stVal):'',tgtBpm=mt&&mt.bpm?Math.round(mt.bpm*tp):0;
  h=`<div class="song147-subcard c-cyan"><b>🎵 原曲调性与速度自动识别（BPM &amp; Key）</b>
   <div class="btns"><button type="button" class="btn-mint small" data-e147="detectKB">🔍 识别原曲调性与 BPM</button>${mt?.bpm?`<button type="button" class="ghost small" data-e147="syncBpm">同步 ${tgtBpm} BPM 到预备拍</button>`:''}</div>
   ${mt?`<p class="sub">原曲识别：<b>${esc(mt.keyName)}</b>（${esc(mt.shortName)}）· <b>${mt.bpm} BPM</b>${(Math.abs(stVal)>0.01||Math.abs(tp-1)>0.01)?` → 当前目标：<b>${esc(tgtKey)}</b> · <b>${tgtBpm} BPM</b>`:''}</p>`:`<p class="sub">导入伴奏后一键识别原调与节拍速度，升降调或变速时自动实时换算目标调性与 BPM。</p>`}
  </div>
  <div class="song147-subcard c-violet"><b>🎼 独立升降调（立体声相位锁定 IPL + 共振峰保护引擎）</b>
   <div class="btns">${[-5,-3,-2,-1,0,1,2,3,5].map(v=>`<button type="button" class="${Math.abs(stVal-v)<0.01?'btn-mint':'ghost'} small" data-e147="pitch" data-v="${v}">${v===0?'原调':(v>0?'+':'')+v}</button>`).join('')}</div>
   <div class="song146-band"><span>移调幅度<small>支持 0.5 半音微调</small></span><input id="e147Pitch" type="range" min="-12" max="12" step="0.5" value="${stVal}"><output id="e147PitchOut">${stTxt}</output></div>
   <label class="song146-dyn"><input type="checkbox" id="e147Formant" ${fm?'checked':''}><span><b>人声共振峰保护（Formant）</b><small>采用独立相位锁定声码器与谱包络校正，升降调不发尖、不变怪声；试听与导出同步生效</small></span></label>
  </div>
  <div class="song147-subcard c-blue"><b>🐢 变速不变调（慢练 / 加速）</b>
   <div class="btns">${[0.5,0.75,0.85,1,1.15,1.25,1.5].map(v=>`<button type="button" class="${Math.abs(tp-v)<0.01?'btn-mint':'ghost'} small" data-e147="tempo" data-v="${v}">${v.toFixed(2).replace(/\.00$/,'')}×</button>`).join('')}</div>
   <div class="song146-band"><span>当前倍速<small>可与上方升降调同时叠加</small></span><input id="e147Tempo" type="range" min="0.5" max="1.5" step="0.05" value="${tp}"><output id="e147TempoOut">${tp.toFixed(2)}×</output></div>
  </div>
  <div class="song147-subcard c-indigo"><b>🎚 双轨混音（背景音乐 / 伴奏叠加）</b>
   <label class="field">选择背景轨 / 伴奏文件（MP3 / WAV / M4A / OGG）<input id="e147BgFile" type="file" accept=".mp3,.wav,.m4a,.ogg,.webm,audio/*"></label>
   ${bg?`<p class="sub">当前背景轨：<b>${esc(bgName)}</b></p>
   <div class="song146-band"><span>背景轨音量<small>相对主轨 dB</small></span><input id="e147BgGain" type="range" min="-30" max="6" step="1" value="${bgDb}"><output id="e147BgGainOut">${bgDb>0?'+':''}${bgDb} dB</output></div>
   <div class="btns"><label class="song147-inline">起点偏移(秒) <input id="e147BgOff" type="number" step="0.1" value="${bgOff}" style="width:82px"></label>
    <button type="button" class="ghost small" data-e147="bgHere">对齐当前播放位置</button>
    <button type="button" class="ghost small" data-e147="bgDel">移除背景轨</button></div>
   <label class="song146-dyn"><input type="checkbox" id="e147BgLoop" ${bg.loop?'checked':''}><span><b>循环铺满全曲</b><small>背景轨短于主轨时自动首尾循环</small></span></label>
   <label class="song146-dyn"><input type="checkbox" id="e147BgDuck" ${bg.duck?'checked':''}><span><b>人声自动闪避（Auto-Ducking）</b><small>主轨有人声/乐器发声时，自动将背景轨平滑压低 ${Math.abs(bg.duckDb||-10)} dB，停顿后自然回升</small></span></label>`
   :'<p class="sub">适合“老师口播讲解 + 轻音乐背景”或“干声清唱 + 伴奏合并”，全部在手机/电脑本地混音。</p>'}
  </div>`;
 }else if(t==='ins'){
  h=`<div class="song147-subcard c-amber"><b>🥁 插入预备拍（节拍器倒计时）</b>
   <div class="btns">
    <select id="e147CiBeats"><option value="4" selected>4 拍</option><option value="8">8 拍</option><option value="3">3 拍（3/4）</option><option value="6">6 拍（6/8）</option></select>
    <label class="song147-inline">BPM <input id="e147CiBpm" type="number" min="40" max="240" value="100" style="width:72px"></label>
    <button type="button" class="ghost small" data-e147="tap">👆 点拍测速</button>
    <button type="button" class="btn-mint small" data-e147="countin0">开头插入</button>
    <button type="button" class="ghost small" data-e147="countin">播放位置插入</button>
   </div>
  </div>
  <div class="btns">
   <button type="button" class="${S.rec?'primary':'btn-mint'}" data-e147="rec">${S.rec?'⏹ 停止录音并插入':'🎙 录音插入播放位置'}</button>
   <select id="e147Sil">${[0.5,1,2,3,4,5,8,10].map(v=>`<option value="${v}" ${v===2?'selected':''}>${v} 秒</option>`).join('')}</select>
   <button type="button" class="ghost" data-e147="silence">插入空白</button>
  </div>
  <label class="field">合并：添加文件到末尾<input id="e147Add" type="file" multiple accept=".mp3,.wav,.m4a,.ogg,.webm,audio/*"></label>
  <label class="field">接缝交叉淡化<select id="e147Xf">${[0,0.5,1,2,3].map(v=>`<option value="${v}" ${v===0?'selected':''}>${v?v+' 秒':'不交叉（直接相接）'}</option>`).join('')}</select></label>
  <p class="sub">片段顺序（可上下移动、删除）：</p>`;
  const {st}=layout(S.P),list=S.P.clips.slice(0,40);
  h+=list.map((c,i)=>`<div class="song147-clip"><span><b>${i+1}. ${c.src==null?'空白':esc(S.P.sources[c.src]?.name||'音频')}${c.rev?' [倒放]':''}</b><small>${fmt(st[i])} – ${fmt(st[i]+len(c))} · ${fmt(len(c))}${c.xf?' · 交叉 '+fmt(c.xf):''}${c.gain!==1?' · '+(20*Math.log10(c.gain||1e-9)).toFixed(1)+' dB':''}</small></span><button type="button" class="ghost small" data-e147="cup" data-i="${i}" ${i?'':'disabled'}>↑</button><button type="button" class="ghost small" data-e147="cdown" data-i="${i}" ${i<S.P.clips.length-1?'':'disabled'}>↓</button><button type="button" class="ghost small" data-e147="cdel" data-i="${i}">✕</button></div>`).join('')+(S.P.clips.length>40?'<p class="sub">片段较多，只列出前 40 个。</p>':'')+(S.P.clips.length?'':'<p class="sub">还没有音频。</p>');
 }else if(t==='tuner'){
  const on=!!S.tuner,chords=P.chords,stOff=Number(P.pitch||0);
  h=`<div class="song147-subcard c-teal"><b>🎯 实时麦克风音准仪 / 调音器（声乐 &amp; 乐器校音）</b>
   <div class="btns"><button type="button" class="${on?'primary':'btn-mint'}" data-e147="tunerToggle">${on?'⏹ 停止音准检测':'🎙 开启实时音准仪'}</button></div>
   <div class="song147-tuner-box">
    <div id="e147TunerNote" class="song147-tuner-note">--</div>
    <div id="e147TunerMeta" class="song147-tuner-meta">${on?'请对着麦克风哼唱或演奏单音…':'点击上方按钮开启实时音高与音分（Cents）检测'}</div>
    <div class="song147-tuner-bar"><div id="e147TunerNeedle" class="song147-tuner-needle"></div></div>
    <canvas id="e147TunerCv" class="song147-tuner-cv" height="110"></canvas>
   </div>
  </div>
  <div class="song147-subcard c-cyan"><b>🎸 全曲和弦走向自动识别（随播放头高亮 · 自动同步移调）</b>
   <div class="btns"><button type="button" class="btn-mint small" data-e147="detectChords">🔍 识别全曲和弦走向</button>${chords?'<button type="button" class="ghost small" data-e147="clearChords">清空和弦</button>':''}</div>
   ${chords?`<div id="e147ChordList" class="song147-chords">${chords.map((c,i)=>{
     const disp=c.root>=0&&global.SongEdit161Pro?global.SongEdit161Pro.transposeChordName(c.root,c.type,stOff):c.name;
     return `<button type="button" class="song147-chord" data-e147="cplay" data-t="${c.t}" data-ci="${i}"><b>${esc(disp)}</b><small>${fmt(c.t*P.rate)}</small></button>`;
    }).join('')}</div><p class="sub">共识别 ${chords.length} 个和弦段${stOff?'（已自动按当前 '+(stOff>0?'+':'')+stOff+' 半音换算）':''}；点击任意和弦即可从该位置播放。</p>`
   :'<p class="sub">纯本地识别大三/小三/属七和弦，适合钢琴即兴伴奏、吉他弹唱与和声分析。</p>'}
  </div>`;
  }else if(t==='mark'){
  h=`<div class="btns"><select id="e147Label">${LABELS.map(v=>`<option>${v}</option>`).join('')}<option value="__custom">自定义…</option></select><button type="button" class="btn-mint" data-e147="mark">📍 播放中实时打标</button></div>
  <div class="btns"><select id="e147GapSec">${[1,1.5,2,3].map(v=>`<option value="${v}" ${v===1.5?'selected':''}>静音 ≥ ${v} 秒</option>`).join('')}</select><button type="button" class="ghost" data-e147="autoMark">✨ 按静音自动打分割标记</button><button type="button" class="ghost small" data-e147="clearMarks">清空标记</button></div>`;
  h+=S.P.markers.length?S.P.markers.map((m,i)=>`<div class="song147-clip"><span><b style="color:${MCOLOR[m.label]||'#9a3e7e'}">● ${esc(m.label)}</b><small>${fmt(m.t)}</small></span><button type="button" class="ghost small" data-e147="mgo" data-i="${i}">跳到</button><button type="button" class="ghost small" data-e147="mplay" data-i="${i}">从此播放</button><button type="button" class="ghost small" data-e147="mdel" data-i="${i}">✕</button></div>`).join(''):'<p class="sub">暂无标记。播放时点击“实时打标”不会中断播放，可直接按节拍切分段落。</p>';
 }else if(t==='batch'){
  h=`<div class="song147-subcard c-indigo"><b>📦 一键批量处理（最多 30 首 · 逐首流式处理自动打包 ZIP）</b>
   <label class="field">选择多首音频（MP3 / WAV / M4A / OGG）<input id="e147BatchFiles" type="file" multiple accept=".mp3,.wav,.m4a,.ogg,.webm,audio/*"></label>
   <div class="btns">
    <label class="song147-inline">统一移调 <select id="e147BatchSt">${[-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6].map(v=>`<option value="${v}" ${v===0?'selected':''}>${v===0?'原调 (0)':(v>0?'+':'')+v+' 半音'}</option>`).join('')}</select></label>
    <label class="song147-inline">响度 <select id="e147BatchNorm"><option value="none">不调整</option><option value="lufs16" selected>-16 LUFS（教学）</option><option value="lufs14">-14 LUFS（演出）</option><option value="peak">-1 dBFS 峰值</option></select></label>
   </div>
   <div class="btns">
    <label class="song147-inline">降噪 <select id="e147BatchDn"><option value="0">关</option><option value="1">轻度</option><option value="2">中度</option></select></label>
    <label class="song147-inline">混响 <select id="e147BatchRev"><option value="off">关</option><option value="studio">温暖录音棚</option><option value="recital">声乐小厅</option></select></label>
    <label class="song147-inline">格式 <select id="e147BatchFmt"><option value="mp3-192" selected>MP3 192k</option><option value="mp3-320">MP3 320k</option><option value="wav">WAV 无损</option></select></label>
   </div>
   <label class="song146-dyn"><input type="checkbox" id="e147BatchTrim" checked><span><b>自动去除每首歌首尾静音</b><small>保留 50 ms 呼吸空间，让全套伴奏/课件起止干脆利落</small></span></label>
   <label class="song146-dyn"><input type="checkbox" id="e147BatchFormant" checked><span><b>批量移调开启共振峰保护</b><small>保持人声自然音色，不发尖不变怪声</small></span></label>
   <div class="btns"><button type="button" class="primary" data-e147="runBatch">🚀 开始批量处理并打包 ZIP</button><button type="button" class="ghost" data-e147="cancel">取消处理</button></div>
   <p class="sub">每首处理完立即释放临时空间，手机端也能稳定批量处理整套教材伴奏。</p>
  </div>`;
 }else if(t==='out'){
  h=`<label class="field">格式<select id="e147Fmt"><option value="mp3">MP3</option><option value="wav">WAV（PCM 16-bit）</option></select></label>
  <label class="field">MP3 码率<select id="e147Kbps"><option value="128">128 kbps</option><option value="192" selected>192 kbps</option><option value="320">320 kbps</option></select></label>
  <div class="btns"><button type="button" class="primary" data-e147="xall">导出整首</button><button type="button" class="btn-mint" data-e147="xsel">导出选区</button><button type="button" class="ghost" data-e147="xmarks">按标记切分导出</button><button type="button" class="btn-mint" data-e147="xzip">📦 按标记切分打包 ZIP</button></div>
  <div class="btns"><button type="button" class="ghost" data-e147="toeq">🎚 送去 EQ 调音</button><button type="button" class="ghost" data-e147="topitch">🎼 送去升降调</button><button type="button" class="ghost" data-e147="cancel">取消处理</button></div>
  <p class="sub">导出自动应用当前升降调、倍速、降噪、混响、KTV 声道与双轨混音，并在 -1.5 dBFS 以上柔和限幅防削波。</p>
  <div class="song147-subcard c-violet"><b>🎬 一键生成动态波形展示视频（发抖音 / 视频号 / 小红书）</b>
   <div class="btns">
    <label class="song147-inline">标题 <input id="e147VidTitle" type="text" placeholder="留空自动使用歌名" style="width:150px"></label>
    <select id="e147VidRatio"><option value="9:16" selected>9:16 竖屏（抖音/小红书）</option><option value="16:9">16:9 横屏（B站/教学）</option></select>
   </div>
   <label class="field">自定义封面图片（可选，留空自动生成高级渐变背景）<input id="e147VidCover" type="file" accept="image/*"></label>
   <div class="btns"><button type="button" class="btn-mint small" data-e147="makeVideo">🎬 生成动态波形视频（选区或整首）</button></div>
   <p class="sub">纯本地实时渲染跳动波形与音轨合成视频，适合发翻唱打卡或声乐示范（长曲目建议先选 30–60 秒高潮选区生成最快）。</p>
  </div>
  <div class="song147-subcard c-green"><b>💾 常用参数模板 &amp; 工程档案</b>
   <div class="btns"><button type="button" class="btn-mint small" data-e147="saveTpl">保存当前参数为常用模板</button><button type="button" class="ghost small" data-e147="loadTpl">⚡ 一键套用模板</button><button type="button" class="ghost small" data-e147="expJson">导出工程 JSON</button><button type="button" class="ghost small" data-e147="impJson">导入参数 JSON</button></div>
   <p class="sub">可把老师常用的「降噪 + 录音棚混响 + 移调/倍速」存为本机模板，下次打开新音频一键套用。</p>
  </div>`;
 }
 const p=q('#e147Panel');if(p)p.innerHTML=h;
 S.host?.querySelectorAll('[data-e147-tab]').forEach(b=>b.classList.toggle('on',b.dataset.e147Tab===S.tab));
}
function refresh(){panel();info();draw();}
function info(){
 const n=q('#e147Info');if(!n)return;const t=T(),files=Object.keys(S.P.sources).length;
 const badges=[];
 if(S.P.pitch&&Math.abs(S.P.pitch)>1e-4)badges.push((S.P.pitch>0?'升 ':'降 ')+Math.abs(S.P.pitch)+' 半音');
 if(S.P.tempo&&Math.abs(S.P.tempo-1)>1e-4)badges.push(`倍速 ${S.P.tempo.toFixed(2)}×`);
 if(S.P.chMode&&S.P.chMode!=='stereo')badges.push({left:'仅左声道',right:'仅右声道',mono:'单声道'}[S.P.chMode]);
 if(S.P.denoise)badges.push('降噪'+['','轻','中','强'][S.P.denoise]);
 if(S.P.comp&&S.P.comp!=='off')badges.push({gentle:'轻压缩',vocal:'人声压缩',master:'母带压缩'}[S.P.comp]||'压缩');
 if(S.P.reverb&&S.P.reverb!=='off')badges.push((global.SongEdit161Pro?.REVERB_PRESETS?.[S.P.reverb]?.name||'混响'));
 if(S.P.meta)badges.push(S.P.meta.shortName+' '+S.P.meta.bpm+'BPM');
 if(S.P.bg)badges.push(S.P.bg.duck?'双轨+闪避':'双轨混音');
 n.textContent=S.P.clips.length?`${files} 个文件 · 总长 ${fmt(t)} · ${S.P.clips.length} 片段`+(badges.length?' · '+badges.join(' / '):'')+(t>S.P.rate*1200?' · ⚠ 超过 20 分钟':''):'请先打开音频';
 const set=(id,v)=>{const e=q(id);if(e&&document.activeElement!==e)e.value=v;};
 set('#e147A',S.sel?fmt(S.sel.a):'');set('#e147B',S.sel?fmt(S.sel.b):'');set('#e147L',S.sel?fmt(S.sel.b-S.sel.a):'');set('#e147P',fmt(S.ph));
 S.host?.querySelectorAll('[data-e147="undo"]').forEach(u=>{u.disabled=!S.undo.length;});S.host?.querySelectorAll('[data-e147="redo"]').forEach(r=>{r.disabled=!S.redo.length;});
}

function prep(c){const dpr=Math.min(3,global.devicePixelRatio||1),w=c.clientWidth||320,h=c.clientHeight||150;if(c.width!==Math.round(w*dpr)){c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);}else if(c.height!==Math.round(h*dpr))c.height=Math.round(h*dpr);const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);return {g,w,h};}
function draw(){
 const main=q('#e147Main'),over=q('#e147Over');if(!main||!over)return;const t=T();if(!S.spp)fit();
 {const {g,w,h}=prep(over);g.clearRect(0,0,w,h);g.fillStyle='#fbf3f8';g.fillRect(0,0,w,h);if(t){const spp=t/w,pk=columnPeaks(S.P,0,spp,Math.ceil(w)),sx0=S.sel?S.sel.a/spp:-1,sx1=S.sel?S.sel.b/spp:-1;
  if(S.sel){g.fillStyle='rgba(20,184,166,.18)';g.fillRect(sx0,0,Math.max(1,sx1-sx0),h);}
  for(let x=0;x<w;x++){const a=Math.min(1,pk[x])*(h/2-2);g.fillStyle=(S.sel&&x>=sx0&&x<=sx1)?'#0f766e':'#c79bbb';g.fillRect(x,h/2-a,1,Math.max(1,2*a));}
  g.strokeStyle='#9a3e7e';g.lineWidth=1.5;g.strokeRect(S.v0/spp+0.75,0.75,Math.max(3,S.spp*width()/spp)-1.5,h-1.5);g.fillStyle='#d6336c';g.fillRect(S.ph/spp-0.5,0,1.5,h);}}
 const {g,w,h}=prep(main),wave=h-18,mid=wave/2;g.clearRect(0,0,w,h);g.fillStyle='#fffafd';g.fillRect(0,0,w,h);
 if(!t){g.fillStyle='#8c7a88';g.font='14px sans-serif';g.textAlign='center';g.fillText('请先打开音频文件（或点“插入 / 录音”直接录制）',w/2,h/2);return;}
 const X=s=>(s-S.v0)/S.spp;
 const sx0=S.sel?X(S.sel.a):-1,sx1=S.sel?X(S.sel.b):-1;
 if(S.sel){g.fillStyle='rgba(20,184,166,.16)';g.fillRect(sx0,0,Math.max(1,sx1-sx0),wave);}
 // 背景轨预览波形（底部薄荷绿半透明层）
 const bgPk=bgColumnPeaks(S.P,S.v0,S.spp,Math.ceil(w));
 if(bgPk){g.fillStyle='rgba(42,157,143,.28)';const bh=wave*0.24;for(let x=0;x<w;x++){const a=bgPk[x]*bh;if(a>0.5)g.fillRect(x,wave-a,1,a);}}
 g.strokeStyle='#efe3ec';g.beginPath();g.moveTo(0,mid+.5);g.lineTo(w,mid+.5);g.stroke();
 const deep=S.deep&&S.deep.key===S.ver+'|'+S.v0+'|'+S.spp+'|'+Math.ceil(w)?S.deep:null;
 const baseWaveCol=S.sel?'#b98cb0':'#9a3e7e',selWaveCol='#0f766e';
 if(deep){for(let x=0;x<w;x++){const lo=deep.lo[x],hi=deep.hi[x];g.fillStyle=(S.sel&&x>=sx0&&x<=sx1)?selWaveCol:baseWaveCol;g.fillRect(x,mid-hi*(mid-3),1,Math.max(1,(hi-lo)*(mid-3)));}}
 else{const pk=columnPeaks(S.P,S.v0,S.spp,Math.ceil(w));for(let x=0;x<w;x++){const a=Math.min(1,pk[x])*(mid-3);g.fillStyle=(S.sel&&x>=sx0&&x<=sx1)?selWaveCol:baseWaveCol;g.fillRect(x,mid-a,1,Math.max(1,2*a));}if(S.spp<BUCKET&&!S.play)deepLoad(Math.ceil(w));}
 // 片段边界
 const {st}=layout(S.P);g.strokeStyle='rgba(120,120,140,.45)';g.setLineDash([3,3]);for(let i=1;i<st.length;i++){const x=X(st[i]);if(x>=0&&x<=w){g.beginPath();g.moveTo(x+.5,0);g.lineTo(x+.5,wave);g.stroke();}}g.setLineDash([]);
 // 选区把手（与选中波形一致的青绿色）
 if(S.sel){for(const s of [S.sel.a,S.sel.b]){const x=X(s);if(x<-12||x>w+12)continue;g.fillStyle='#0f766e';g.fillRect(x-1,0,2,wave);g.beginPath();g.arc(x,wave-12,9,0,Math.PI*2);g.fill();g.beginPath();g.arc(x,12,7,0,Math.PI*2);g.fill();g.fillStyle='#fff';g.beginPath();g.arc(x,wave-12,3,0,Math.PI*2);g.fill();}}
 // 标记
 g.font='11px sans-serif';g.textAlign='left';for(const m of S.P.markers){const x=X(m.t);if(x<-40||x>w)continue;const c=MCOLOR[m.label]||'#9a3e7e';g.fillStyle=c;g.fillRect(x,0,2,wave);const tw=g.measureText(m.label).width+8;g.fillRect(x,0,tw,15);g.fillStyle='#fff';g.fillText(m.label,x+4,11);}
 // 时间刻度
 g.fillStyle='#f3eaf0';g.fillRect(0,wave,w,18);const secPx=S.P.rate/S.spp,steps=[0.01,0.05,0.1,0.25,0.5,1,2,5,10,15,30,60,120,300,600];const step=steps.find(s=>s*secPx>=64)||600;
 g.fillStyle='#7c6a78';g.font='10px sans-serif';const s0=Math.floor(S.v0/S.P.rate/step)*step;for(let s=s0;s*S.P.rate<S.v0+w*S.spp;s+=step){const x=X(s*S.P.rate);if(x<0)continue;g.fillRect(x,wave,1,5);const m=Math.floor(s/60),r=s-m*60;g.fillText(m+':'+(r<10?'0':'')+(step<1?r.toFixed(2):Math.round(r)),x+2,h-4);}
 // 播放头
 const px=X(S.ph);if(px>=-2&&px<=w+2){g.fillStyle='#d6336c';g.fillRect(px-1,0,2,wave);g.beginPath();g.moveTo(px-6,0);g.lineTo(px+6,0);g.lineTo(px,8);g.fill();}
 info();
}
let deepTok=0;
async function deepLoad(w){const key=S.ver+'|'+S.v0+'|'+S.spp+'|'+w,tok=++deepTok;await new Promise(r=>setTimeout(r,60));if(tok!==deepTok)return;
 const n=Math.ceil(w*S.spp)+1,d=await renderRange(S.P,Math.floor(S.v0),n);if(tok!==deepTok)return;const lo=new Float32Array(w),hi=new Float32Array(w);
 for(let x=0;x<w;x++){let a=1,b=-1;const i0=Math.floor(x*S.spp),i1=Math.max(i0+1,Math.floor((x+1)*S.spp));for(let i=i0;i<i1&&i<n;i++){const v=(d[0][i]+d[1][i])/2;if(v<a)a=v;if(v>b)b=v;}if(a>b){a=0;b=0;}lo[x]=Math.max(-1,a);hi[x]=Math.min(1,b);}
 S.deep={key,lo,hi};draw();}

// ---------- 手势 ----------
function bindCanvas(){
 const c=q('#e147Main'),o=q('#e147Over'),pts=new Map();let mode=null,start=0,moved=false,pinch=null,prevSel=null;
 const tAt=x=>clamp(Math.round(S.v0+x*S.spp),0,T());const lx=e=>e.clientX-c.getBoundingClientRect().left;
 c.addEventListener('pointerdown',e=>{if(!T())return;c.setPointerCapture(e.pointerId);pts.set(e.pointerId,lx(e));
  if(pts.size===2){if(mode==='new'||mode==='a'||mode==='b')S.sel=prevSel;mode='pinch';const [x1,x2]=[...pts.values()];pinch={d:Math.abs(x1-x2)||1,spp:S.spp,tm:S.v0+((x1+x2)/2)*S.spp};return;}
  if(pts.size>2)return;const x=lx(e);prevSel=S.sel?{...S.sel}:null;moved=false;
  if(S.sel&&Math.abs(x-(S.sel.a-S.v0)/S.spp)<20)mode='a';else if(S.sel&&Math.abs(x-(S.sel.b-S.v0)/S.spp)<20)mode='b';else{mode='new';start=tAt(x);}});
 c.addEventListener('pointermove',e=>{if(!pts.has(e.pointerId))return;pts.set(e.pointerId,lx(e));
  if(mode==='pinch'&&pts.size>=2){const [x1,x2]=[...pts.values()];const d=Math.abs(x1-x2)||1;S.spp=pinch.spp*pinch.d/d;clampView();S.v0=pinch.tm-((x1+x2)/2)*S.spp;clampView();draw();return;}
  const x=lx(e),t=tAt(x);
  if(mode==='new'){if(!moved&&Math.abs(t-start)/S.spp<6)return;moved=true;S.sel={a:Math.min(start,t),b:Math.max(start,t)};}
  else if(mode==='a'||mode==='b'){moved=true;const o2=mode==='a'?S.sel.b:S.sel.a;if(mode==='a'&&t>o2||mode==='b'&&t<o2)mode=mode==='a'?'b':'a';S.sel=mode==='a'?{a:t,b:o2}:{a:o2,b:t};}
  const w=width();if(moved&&(x<16||x>w-16)){S.v0+=(x<16?-1:1)*S.spp*8;clampView();}
  draw();});
 const end=async e=>{if(!pts.has(e.pointerId))return;pts.delete(e.pointerId);if(mode==='pinch'){if(!pts.size)mode=null;return;}
  if(mode==='new'&&!moved){S.sel=null;seek(tAt(lx(e)));}
  else if(moved&&S.sel){if(S.sel.b-S.sel.a<2)S.sel=null;else if(S.snap){const a=await snapZero(S.P,S.sel.a),b=await snapZero(S.P,S.sel.b);if(S.sel)S.sel={a:Math.min(a,b),b:Math.max(a,b)};}if(S.sel&&!S.play)S.ph=S.sel.a;}
  mode=null;draw();};
 c.addEventListener('pointerup',end);c.addEventListener('pointercancel',end);
 c.addEventListener('wheel',e=>{if(!T())return;e.preventDefault();zoom(e.deltaY>0?1.25:0.8,S.v0+lx(e)*S.spp);},{passive:false});
 const ov=e=>{const t=T();if(!t)return;const r=o.getBoundingClientRect(),x=e.clientX-r.left,ct=x/r.width*t;S.v0=ct-S.spp*width()/2;clampView();draw();};
 let od=false;o.addEventListener('pointerdown',e=>{od=true;o.setPointerCapture(e.pointerId);ov(e);});o.addEventListener('pointermove',e=>{if(od)ov(e);});o.addEventListener('pointerup',()=>{od=false;});o.addEventListener('pointercancel',()=>{od=false;});
}

// ---------- 播放（支持变速不变调流式播放，按 0.5–2 秒小段渲染并排队） ----------
function stopPlay(){const p=S.play;if(!p)return;p.stopped=true;clearTimeout(p.timer);for(const n of p.nodes)try{n.stop()}catch(_){}S.play=null;const b=q('#e147PlayBtn');if(b)b.textContent='▶ 播放';draw();}
function seek(t){const wasPlaying=S.play&&!S.play.sel;S.ph=clamp(t,0,T());if(S.play){stopPlay();if(wasPlaying)startPlay(S.ph,T(),false);}draw();}
function startPlay(from,to,loop,sel=false){
 stopPlay();if(to-from<S.P.rate*0.02)return;try{if(navigator.audioSession)navigator.audioSession.type='playback';}catch(_){}
 const AC=global.AudioContext||global.webkitAudioContext;if(!S.ctx)S.ctx=new AC();const ctx=S.ctx;ctx.resume?.();
 const tempo=clamp(Number(S.P.tempo)||1,0.5,1.5),pitch=clamp(Number(S.P.pitch)||0,-12,12),formant=S.P.formant!==false;
 const dnLvl=S.P.denoise||0,dnProc=(dnLvl>0&&global.SongEdit161Pro?.createDenoiseProcessor)?global.SongEdit161Pro.createDenoiseProcessor(S.P.rate,dnLvl):null;
 const compKey=S.P.comp||'off',compProc=(compKey!=='off'&&global.SongEdit161Pro?.createCompressorProcessor)?global.SongEdit161Pro.createCompressorProcessor(S.P.rate,compKey):null;
 const revKey=S.P.reverb||'off',reverbProc=(revKey!=='off'&&global.SongEdit161Pro?.createReverbProcessor)?global.SongEdit161Pro.createReverbProcessor(S.P.rate,revKey,S.P.reverbMix??1):null;
 const p={stopped:false,nodes:[],segs:[],cursor:from,end:to,a:from,loop,sel,tempo,pitch,formant,dnProc,compProc,reverbProc,stretcher:null,when:ctx.currentTime+0.06,first:true,needFadeIn:true,done:false};
 S.play=p;const b=q('#e147PlayBtn');if(b)b.textContent='⏸ 暂停';pump(p);tick();
}
async function pump(p){
 if(p.busy||p.stopped)return;p.busy=true;const ctx=S.ctx,R=S.P.rate,usePitch=Math.abs(p.pitch)>1e-4,useStretch=usePitch||Math.abs(p.tempo-1)>1e-4;
 try{
  if(useStretch&&!p.stretcher){
   if(usePitch){p.stretcher=createProPitchEngine(R,{semitones:p.pitch,tempo:p.tempo,formant:p.formant});status('正在以 '+(p.pitch>0?'+':'')+p.pitch+' 半音'+(Math.abs(p.tempo-1)>1e-4?' · '+p.tempo.toFixed(2)+'×':'')+' 实时试听');}
   else{status('正在加载变速不变调引擎…');p.stretcher=await createTempoStretcher(R,p.tempo);if(p.stopped)return;status('正在以 '+p.tempo.toFixed(2)+'× 变速不变调试听');}
   p.when=Math.max(p.when,ctx.currentTime+0.04);
  }
  while(!p.stopped&&p.when<ctx.currentTime+2){
   if(p.cursor>=p.end){
    if(p.loop&&p.end-p.a>R*0.05){p.cursor=p.a;if(useStretch)p.stretcher=usePitch?createProPitchEngine(R,{semitones:p.pitch,tempo:p.tempo,formant:p.formant}):await createTempoStretcher(R,p.tempo);}
    else{
     if(useStretch&&p.stretcher){const tail=p.stretcher.finish();p.stretcher=null;if(tail[0].length&&!p.stopped){const buf=ctx.createBuffer(2,tail[0].length,R);buf.getChannelData(0).set(tail[0]);buf.getChannelData(1).set(tail[1]);const node=ctx.createBufferSource();node.buffer=buf;node.connect(ctx.destination);const w=Math.max(p.when,ctx.currentTime+0.02);node.start(w);p.nodes.push(node);node.onended=()=>{p.nodes=p.nodes.filter(x=>x!==node);};p.when=w+tail[0].length/R;}}
     p.done=true;break;
    }
   }
   const segStart=p.cursor;
   const n=Math.min(p.first?Math.round(R*0.6):Math.round(R*1.6),p.end-p.cursor);p.first=false;
   let d=await renderRange(S.P,segStart,n);if(p.stopped)break;
   if(p.dnProc)d=p.dnProc.process(d[0],d[1]);
   if(p.compProc)d=p.compProc.process(d[0],d[1]);
   if(p.reverbProc)d=p.reverbProc.process(d[0],d[1]);
   p.cursor+=n;
   const out=useStretch?p.stretcher.push(d[0],d[1]):d;
   if(!out[0].length)continue;
   const outLen=out[0].length,oL=new Float32Array(outLen),oR=new Float32Array(outLen);
   const fi=p.needFadeIn?Math.min(outLen,Math.round(R*0.006)):0;p.needFadeIn=false;
   for(let i=0;i<outLen;i++){let l=soft(out[0][i]),r=soft(out[1][i]);if(i<fi){const k=(i+1)/fi;l*=k;r*=k;}oL[i]=l;oR[i]=r;}
   const buf=ctx.createBuffer(2,outLen,R);buf.getChannelData(0).set(oL);buf.getChannelData(1).set(oR);
   const node=ctx.createBufferSource();node.buffer=buf;node.connect(ctx.destination);
   const w=Math.max(p.when,ctx.currentTime+0.02);node.start(w);p.nodes.push(node);node.onended=()=>{p.nodes=p.nodes.filter(x=>x!==node);};
   p.segs.push({w,pos:segStart,n,outLen});if(p.segs.length>10)p.segs.shift();p.when=w+outLen/R;
  }
 }catch(e){status('播放失败：'+(e?.message||e));stopPlay();}finally{p.busy=false;}
 if(!p.stopped&&!p.done)p.timer=setTimeout(()=>pump(p),260);
}
function tick(){
 cancelAnimationFrame(S.raf);
 const step=()=>{
  const p=S.play;if(!p)return;if(!S.host?.isConnected){stopPlay();return;}
  const now=S.ctx.currentTime;let ph=null;
  for(const s of p.segs)if(now>=s.w)ph=s.pos+Math.min(s.n,(now-s.w)*S.P.rate*p.tempo);
  if(ph!=null)S.ph=Math.round(ph);
  if(p.done&&now>=p.when){stopPlay();S.ph=p.sel?p.a:p.end;draw();return;}
  const w=width();if(S.ph>S.v0+S.spp*w*0.92||S.ph<S.v0){S.v0=S.ph-S.spp*w*0.1;clampView();}
  if(S.tab==='tuner'&&S.P.chords?.length){const sec=S.ph/S.P.rate;S.host?.querySelectorAll('.song147-chord').forEach((el,idx)=>{const c=S.P.chords[idx];el.classList.toggle('now',!!(c&&sec>=c.t&&sec<c.end));});}
  draw();S.raf=requestAnimationFrame(step);
 };
 S.raf=requestAnimationFrame(step);
}

// ---------- 动作 ----------
async function task(label,fn){if(S.busy){status('正在处理，请稍候…');return;}stopPlay();const job={cancelled:false};S.busy=job;const pr=q('#e147Progress');try{status(label+'…');await fn(job,p=>{if(pr?.isConnected)pr.value=p;});}catch(e){if(!job.cancelled)status(label+'失败：'+(e?.message||e));else status('已取消');}finally{if(S.busy===job)S.busy=null;if(pr?.isConnected)pr.value=0;}}
async function openFiles(files,{replace=false,xf=0}={}){
 files=[...files].filter(Boolean);if(!files.length)return;
 await task('正在导入',async(job,prog)=>{
  const added=[];for(const [k,f] of files.entries()){status(`正在导入 ${k+1}/${files.length}：${f.name||'音频'}（解码到本机临时空间）`);const src=await importFile(S.P,f,{cancelled:()=>job.cancelled,onProgress:p=>prog(Math.round((k+p/100)/files.length*100))});added.push(src);}
  edit(()=>{if(replace){S.P.clips=[];S.P.markers=[];S.P.bg=null;S.P.tempo=1;S.P.pitch=0;S.P.formant=true;S.P.hq3=null;S.P.denoise=0;S.P.comp='off';S.P.reverb='off';S.P.reverbMix=1;S.P.meta=null;S.P.chords=null;S.P.chMode='stereo';}for(const s of added)append(S.P,[srcClip(s)],xf*S.P.rate);});if(replace){S.undo=[];S.redo=[];S.ph=0;}fit();draw();
  status('已导入 '+added.length+' 个文件。'+(T()>S.P.rate*1200?'总长超过 20 分钟，手机上导出可能较慢。':''));
 });
}
async function openBgFile(file){
 if(!file)return;
 await task('正在导入背景轨',async(job,prog)=>{
  const src=await importFile(S.P,file,{cancelled:()=>job.cancelled,onProgress:prog});
  edit(()=>{S.P.bg={src:src.id,offset:0,gain:Math.pow(10,-9/20),loop:true,duck:true,duckDb:-10};},true);
  status('已叠加背景轨「'+src.name+'」（默认 -9 dB + 自动闪避）');
 });
}
function selRange(){return S.sel?[S.sel.a,S.sel.b]:null;}
async function exportFile(a,b,suffix,job,prog){
 const dlSel=q('#e147Hq3DlFmt')?.value;const f=dlSel?(dlSel==='wav'?'wav':'mp3'):(q('#e147Fmt')?.value||'mp3'),kbps=dlSel?(dlSel==='mp3-320'?320:192):(Number(q('#e147Kbps')?.value)||192);
 const r=await exportRange(S.P,a,b,{cancelled:()=>job.cancelled,onProgress:p=>prog(f==='mp3'?Math.round(p*0.4):p)});S.outs.push(r.opfs);let file=r.file;
 if(f==='mp3'){const M=S.deps?.mp3||global.SongMP3134;if(!M)throw Error('MP3 编码模块未加载');const m=await M.fromWav(r.file,{kbps,cancelled:()=>job.cancelled,onProgress:p=>prog(40+Math.round(p*0.6))});await removeOPFS(r.opfs);file=m.file;}
 return {file,name:root()+(suffix?'-'+suffix:'')+'.'+f};
}
function root(){const first=S.P.clips.find(c=>c.src!=null),n=first?S.P.sources[first.src]?.name:'';return (n||'音频').replace(/\.[^.]+$/,'')+'-编辑';}
function showResult(items,append){
 const t=q('#e147Result');if(!t)return;if(!append)t.replaceChildren();
 for(const it of items){
  const u=URL.createObjectURL(it.file);S.urls.push(u);
  const box=document.createElement('div');box.className='song122-stem';
  const b=document.createElement('b');b.textContent=it.name;
  box.append(b);
  if(/\.(mp4|webm)$/i.test(it.name)){const vd=document.createElement('video');vd.controls=true;vd.playsInline=true;vd.style.maxWidth='100%';vd.style.maxHeight='360px';vd.style.borderRadius='10px';vd.src=u;box.append(vd);}else if(!/\.zip$/i.test(it.name)){const au=document.createElement('audio');au.controls=true;au.preload='metadata';au.src=u;box.append(au);}
  const a=document.createElement('a');a.className='btn-mint';a.href=u;a.download=it.name;a.textContent='下载 '+it.name.split('.').pop().toUpperCase();
  box.append(a);t.append(box);
 }
}


function stopTuner(){
 if(!S.tuner)return;
 cancelAnimationFrame(S.tuner.raf);
 try{S.tuner.stream.getTracks().forEach(tr=>tr.stop());}catch(_){}
 try{S.tuner.ctx.close();}catch(_){}
 S.tuner=null;
}
async function toggleTuner(){
 if(S.tuner){stopTuner();panel();return status('已关闭实时音准仪');}
 if(!navigator.mediaDevices?.getUserMedia)throw Error('当前浏览器不支持麦克风权限');
 if(!global.SongEdit161Pro?.detectPitchYIN)throw Error('音准检测引擎未加载');
 const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
 const AC=global.AudioContext||global.webkitAudioContext;
 const ctx=new AC(),src=ctx.createMediaStreamSource(stream),an=ctx.createAnalyser();
 an.fftSize=4096;src.connect(an);
 const buf=new Float32Array(an.fftSize),hist=[];
 const st={stream,ctx,an,raf:0};S.tuner=st;panel();
 status('🎙 实时音准仪已开启，请发声或演奏单音');
 const loop=()=>{
  if(S.tuner!==st)return;
  an.getFloatTimeDomainData(buf);
  const res=global.SongEdit161Pro.detectPitchYIN(buf,ctx.sampleRate);
  const noteEl=q('#e147TunerNote'),metaEl=q('#e147TunerMeta'),ndl=q('#e147TunerNeedle'),cv=q('#e147TunerCv');
  if(res){
   hist.push(res.midi);if(hist.length>120)hist.shift();
   const col=Math.abs(res.cents)<=10?'#0f766e':Math.abs(res.cents)<=25?'#d97706':'#dc2626';
   if(noteEl){noteEl.textContent=res.note;noteEl.style.color=col;}
   if(metaEl)metaEl.textContent=`${res.freq.toFixed(1)} Hz · ${res.cents>0?'+':''}${res.cents} 音分（${Math.abs(res.cents)<=10?'音准很稳':res.cents>0?'略偏高':'略偏低'}）`;
   if(ndl)ndl.style.left=clamp(50+res.cents,2,98)+'%';
  }else{
   hist.push(null);if(hist.length>120)hist.shift();
   if(noteEl){noteEl.textContent='--';noteEl.style.color='#8c7a88';}
   if(metaEl)metaEl.textContent='等待稳定单音信号…';
  }
  if(cv&&cv.isConnected){
   const {g,w,h}=prep(cv);g.clearRect(0,0,w,h);g.fillStyle='#fffafd';g.fillRect(0,0,w,h);
   const valid=hist.filter(x=>x!=null);
   if(valid.length){
    const center=valid[valid.length-1],span=12;
    g.strokeStyle='#f1e7ee';g.beginPath();g.moveTo(0,h/2);g.lineTo(w,h/2);g.stroke();
    g.strokeStyle='#0f766e';g.lineWidth=2.5;g.beginPath();
    let started=false;
    for(let i=0;i<hist.length;i++){
     const m=hist[i];if(m==null){started=false;continue;}
     const x=i/120*w,y=clamp(h/2-(m-center)/span*(h*0.8),6,h-6);
     if(!started){g.moveTo(x,y);started=true;}else g.lineTo(x,y);
    }
    g.stroke();
   }
  }
  st.raf=requestAnimationFrame(loop);
 };
 st.raf=requestAnimationFrame(loop);
}

async function generateWaveformVideo(P,a,b,opt,job,prog){
 if(typeof MediaRecorder==='undefined')throw Error('当前浏览器不支持本地视频录制');
 const wavRes=await exportRange(P,a,b,{cancelled:()=>job.cancelled,onProgress:p=>prog(Math.round(p*0.25))});
 let audioCtx=null;
 try{
  const AC=global.AudioContext||global.webkitAudioContext;
  audioCtx=new AC();
  const ab=await wavRes.file.arrayBuffer();if(job.cancelled)throw Error('已取消');
  const audioBuf=await audioCtx.decodeAudioData(ab.slice(0));
  const vert=opt.ratio==='9:16',W=vert?720:1280,H=vert?1280:720;
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;
  const g=cv.getContext('2d');
  const dest=audioCtx.createMediaStreamDestination();
  const src=audioCtx.createBufferSource();src.buffer=audioBuf;
  const an=audioCtx.createAnalyser();an.fftSize=256;an.smoothingTimeConstant=0.82;
  src.connect(an);an.connect(dest);
  const vStream=cv.captureStream(30);
  const combo=new MediaStream([...vStream.getVideoTracks(),...dest.stream.getAudioTracks()]);
  const mime=['video/mp4;codecs=avc1,mp4a.40.2','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(m=>MediaRecorder.isTypeSupported(m))||'video/webm';
  const ext=mime.includes('mp4')?'mp4':'webm';
  const mr=new MediaRecorder(combo,{mimeType:mime,videoBitsPerSecond:2500000});
  const chunks=[];mr.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
  const freq=new Uint8Array(an.frequencyBinCount);
  const title=opt.title||root(),sub=P.meta?`${P.meta.keyName} · ${P.meta.bpm} BPM`:'音频专业工作室';
  const coverImg=S.vidCover||null;
  const dur=audioBuf.duration;

  const doneP=new Promise((resolve,reject)=>{mr.onstop=()=>resolve();mr.onerror=e=>reject(e.error||Error('视频录制出错'));});
  mr.start(250);
  const t0=audioCtx.currentTime;src.start(0);
  await new Promise((resolve,reject)=>{
   const drawFrame=()=>{
    if(job.cancelled){try{src.stop()}catch(_){}try{mr.stop()}catch(_){}return reject(Error('已取消'));}
    const el=audioCtx.currentTime-t0;
    prog(25+Math.min(73,Math.round(el/Math.max(0.1,dur)*73)));
    status(`🎬 正在实时合成波形视频：${el.toFixed(1)}s / ${dur.toFixed(1)}s（请保持页面打开）`);
    // 背景
    const grd=g.createLinearGradient(0,0,W,H);grd.addColorStop(0,'#17253b');grd.addColorStop(0.55,'#2f1c3a');grd.addColorStop(1,'#0f3d3e');
    g.fillStyle=grd;g.fillRect(0,0,W,H);
    if(coverImg){
     const sz=Math.min(W,H)*0.48,cx=(W-sz)/2,cy=vert?H*0.16:H*0.14;
     g.save();g.beginPath();g.roundRect?.(cx,cy,sz,sz,24)||g.rect(cx,cy,sz,sz);g.clip();
     g.drawImage(coverImg,cx,cy,sz,sz);g.restore();
    }
    // 标题
    g.fillStyle='#ffffff';g.textAlign='center';g.font='bold '+(vert?38:44)+'px sans-serif';
    g.fillText(title.slice(0,22),W/2,vert?H*0.64:H*0.68);
    g.fillStyle='rgba(255,255,255,0.72)';g.font=(vert?22:24)+'px sans-serif';
    g.fillText(sub,W/2,vert?H*0.69:H*0.74);
    // 频谱波形柱
    an.getByteFrequencyData(freq);
    const bars=48,bw=(W*0.78)/bars,bx0=W*0.11,by=vert?H*0.86:H*0.90,maxH=vert?180:120;
    for(let i=0;i<bars;i++){
     const v=freq[Math.floor(i*freq.length*0.65/bars)]/255,bh=Math.max(6,v*maxH);
     g.fillStyle=i%2?'#2dd4bf':'#f472b6';
     g.fillRect(bx0+i*bw+2,by-bh,Math.max(3,bw-4),bh);
    }
    // 进度条
    g.fillStyle='rgba(255,255,255,0.22)';g.fillRect(W*0.11,by+22,W*0.78,6);
    g.fillStyle='#2dd4bf';g.fillRect(W*0.11,by+22,W*0.78*clamp(el/Math.max(0.1,dur),0,1),6);
    if(el>=dur){mr.stop();resolve();return;}
    setTimeout(drawFrame,33);
   };
   drawFrame();
  });
  await doneP;
  const blob=new Blob(chunks,{type:mime});
  return {file:new File([blob],root()+'-波形视频.'+ext,{type:mime}),name:root()+'-波形视频.'+ext,isVideo:true};
 }finally{
  try{await audioCtx?.close();}catch(_){}
  if(wavRes?.opfs)await removeOPFS(wavRes.opfs);
 }
}
async function toggleRecord(){
 if(S.rec){
  const rec=S.rec;S.rec=null;panel();
  status('正在结束录音并写入时间轴…');
  rec.mr.stop();
  return;
 }
 if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw Error('当前浏览器不支持麦克风录音');
 stopPlay();
 const stream=await navigator.mediaDevices.getUserMedia({audio:true});
 const chunks=[];
 const mr=new MediaRecorder(stream);
 mr.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
 mr.onstop=async()=>{
  stream.getTracks().forEach(tr=>tr.stop());
  const blob=new Blob(chunks,{type:mr.mimeType||'audio/webm'});
  if(!blob.size){status('录音为空');return;}
  const f=new File([blob],'录音-'+new Date().toTimeString().slice(0,8).replace(/:/g,'')+'.webm',{type:blob.type});
  await task('正在解码录音',async(job,prog)=>{
   const src=await importFile(S.P,f,{cancelled:()=>job.cancelled,onProgress:prog});
   const at=S.ph;
   edit(()=>{insertAt(S.P,at,[srcClip(src)]);});
   S.sel={a:at,b:at+src.frames};fit();draw();
   status('已将录音（'+fmt(src.frames)+'）插入到 '+fmt(at));
  });
 };
 mr.start();
 S.rec={mr,stream};panel();
 status('🔴 正在录音中… 完成后再点一次按钮即可停止并插入');
}

async function act(k,btn){
 const P=S.P,t=T(),R=P.rate;
 switch(k){
  case 'wiz':{S.wiz=btn.dataset.v||'vocal';panel();return;}
  case 'wizGo':{S.tab=btn.dataset.v||'vol';panel();q('#e147Panel')?.scrollIntoView({behavior:'smooth',block:'nearest'});return;}
  case 'undo':return undo();case 'redo':return redo();
  case 'zin':return zoom(0.5);case 'zout':return zoom(2);case 'zfit':fit();return draw();
  case 'zsel':if(!needSel())return;S.spp=Math.max(0.5,(S.sel.b-S.sel.a)*1.15/width());S.v0=S.sel.a-(S.sel.b-S.sel.a)*0.075;clampView();return draw();
  case 'home':seek(0);S.v0=0;clampView();return draw();
  case 'play':if(S.play){const ph=S.ph;stopPlay();S.ph=ph;return draw();}if(!t)return status('请先打开音频');return startPlay(S.ph>=t-R*0.05?0:S.ph,t,false);
  case 'playsel':if(!needSel())return;return startPlay(S.sel.a,S.sel.b,S.loop,true);
  case 'loop':S.loop=!S.loop;btn.textContent='🔁 循环：'+(S.loop?'开':'关');if(S.play?.sel)S.play.loop=S.loop;return;
  case 'anudge-':case 'anudge+':case 'bnudge-':case 'bnudge+':{
   if(!t)return;const d=Math.round(R*0.05)*(k.endsWith('+')?1:-1);
   if(!S.sel)S.sel={a:S.ph,b:Math.min(t,S.ph+R)};
   let a=S.sel.a,b=S.sel.b;if(k[0]==='a')a=clamp(a+d,0,b-1);else b=clamp(b+d,a+1,t);
   S.sel={a,b};return draw();
  }
  case 'selall':if(!t)return status('请先打开音频');S.sel={a:0,b:t};draw();return status('已选定全曲（'+fmt(t)+'）');
  case 'selnone':S.sel=null;draw();return status('已取消选区');
  case 'trimSil':{
   if(!t)return status('请先打开音频');
   const r=findTrimBounds(P,-45,0.05);if(!r)return status('整首几乎为静音，无法裁切');
   if(r.trimmedHead<R*0.05&&r.trimmedTail<R*0.05)return status('首尾已很干净，无需去静音');
   edit(()=>crop(P,r.a,r.b));S.ph=0;fit();draw();
   return status(`已去除开头 ${(r.trimmedHead/R).toFixed(2)}s、结尾 ${(r.trimmedTail/R).toFixed(2)}s 静音`);
  }
  case 'copy':if(!needSel())return;S.board=copyRange(P,S.sel.a,S.sel.b);panel();return status('已复制 '+fmt(S.sel.b-S.sel.a));
  case 'cut':if(!needSel())return;{const [a,b]=selRange();edit(()=>{S.board=deleteRange(P,a,b);if(S.board[0])S.board[0].xf=0;});S.ph=a;draw();return status('已剪切 '+fmt(b-a)+'，可在其他位置粘贴');}
  case 'del':if(!needSel())return;{const [a,b]=selRange();edit(()=>deleteRange(P,a,b));S.ph=Math.min(a,T());draw();return status('已删除 '+fmt(b-a));}
  case 'crop':if(!needSel())return;{const [a,b]=selRange();edit(()=>{crop(P,a,b);P.markers=P.markers.map(m=>({...m}));});S.ph=0;fit();draw();return status('已只保留选区（'+fmt(b-a)+'）');}
  case 'rev':if(!needSel())return;{const [a,b]=selRange();edit(()=>reverseRange(P,a,b),true);return status('已倒放选区（'+fmt(b-a)+'）');}
  case 'paste':if(!S.board?.length)return status('剪贴板为空，请先复制或剪切');{const at=S.sel?S.sel.a:S.ph,sel=S.sel?[S.sel.a,S.sel.b]:null;let L=0;edit(()=>{if(sel)deleteRange(P,sel[0],sel[1]);L=insertAt(P,at,S.board);});S.sel={a:at,b:at+L};draw();return status('已粘贴 '+fmt(L));}
  case 'split':if(!t)return;edit(()=>{splitAt(P,S.ph);P.markers.push({t:S.ph,label:'分割'});tidyKeep(P);},true);return status('已在 '+fmt(S.ph)+' 分割（加了“分割”标记，可用于按标记切分导出）');
  case 'fin':case 'fout':if(!needSel())return;{const [a,b]=selRange();edit(()=>fade(P,a,b,k==='fin'?'in':'out'),true);return status((k==='fin'?'淡入':'淡出')+' '+fmt(b-a));}
  case 'mute':if(!needSel())return;{const [a,b]=selRange();edit(()=>silence(P,a,b),true);return status('已静音选区');}
  case 'resetVol':if(!t)return status('请先打开音频');{
   const sel=selRange();
   liveEdit(()=>{
    if(sel)applyRange(P,sel[0],sel[1],c=>{c.gain=1;c.fades=[];});
    else{for(const c of P.clips){c.gain=1;c.fades=[];}tidy(P);}
   },true);
   return status(sel?'已还原选区音量（0 dB）并清除淡入淡出':'已还原整首原始音量（0 dB）并清除全部淡入淡出');
  }
  case 'gain':if(!needSel())return;{const db=Number(q('#e147Gain').value),[a,b]=selRange();edit(()=>gain(P,a,b,db),true);return status('选区音量 '+(db>0?'+':'')+db+' dB'+(db>0?'；导出时有柔和限幅防削波':''));}
  case 'norm':if(!t)return;{const [a,b]=selRange()||[0,t];return task('正在测量峰值',async job=>{const pk=await peakOf(P,a,b,{cancelled:()=>job.cancelled});if(pk<1e-5)return status('选区几乎静音，无法标准化');const db=20*Math.log10(Math.pow(10,-1/20)/pk);edit(()=>gain(P,a,b,db),true);status('已峰值标准化：'+(20*Math.log10(pk)).toFixed(1)+' dBFS → -1 dBFS（'+(db>0?'+':'')+db.toFixed(1)+' dB）');});}
  case 'lufs16':case 'lufs14':if(!t)return;{
   const target=k==='lufs16'?-16:-14,[a,b]=selRange()||[0,t];
   return task('正在测量响度',async job=>{
    const rms=await rmsOf(P,a,b,{cancelled:()=>job.cancelled});
    if(rms<1e-5)return status('选区几乎静音，无法响度标准化');
    const curDb=20*Math.log10(rms),db=clamp(target-curDb,-24,24);
    edit(()=>gain(P,a,b,db),true);
    status(`已响度标准化：原响度约 ${curDb.toFixed(1)} dB → ${target} LUFS（${db>0?'+':''}${db.toFixed(1)} dB，导出含柔和防削波）`);
   });
  }
  case 'chmode':{const v=btn.dataset.v||'stereo';liveEdit(()=>{P.chMode=v;},true);return status('声道模式已切换为：'+{stereo:'原立体声',left:'仅左声道（双耳）',right:'仅右声道（双耳）',mono:'合并单声道'}[v]);}
  case 'denoise':{const v=clamp(Number(btn.dataset.v)||0,0,3);liveEdit(()=>{P.denoise=v;},true);return status('人声降噪：'+['已关闭','轻度（去空调/电流底噪）','中度（去环境杂音）','强力（嘈杂教室）'][v]);}
  case 'runCloudStem':{
   if(!t)return status('请先打开音频');
   const model=q('#e147CloudModel')?.value||'hq3';
   const fmtSel=q('#e147CloudFmt')?.value||'mp3';
   const modelName=model==='bs_roformer'?'BS-RoFormer':'MDX Inst HQ3';
   const [a,b]=selRange()||[0,t];
   return task('云端 GPU 分离（'+modelName+'）',async(job,prog)=>{
    let wavOut=null;
    try{
     status('正在压缩上传音频（本地打包，省流量）…');
     wavOut=await exportRange(P,a,b,{cancelled:()=>job.cancelled,onProgress:p=>prog(Math.round(p*0.12))});
     if(job.cancelled)throw Error('已取消');
     let uploadFile=wavOut.file,uploadName=root()+'.wav';
     const M=S.deps?.mp3||global.SongMP3134;
     if(M&&fmtSel==='mp3'){
      const m=await M.fromWav(wavOut.file,{kbps:192,cancelled:()=>job.cancelled,onProgress:p=>prog(12+Math.round(p*0.13))});
      uploadFile=m.file;uploadName=root()+'.mp3';
     }
     if(job.cancelled)throw Error('已取消');
     status('正在上传至 Modal 云端 GPU（'+(uploadFile.size/1048576).toFixed(1)+' MB）…');prog(28);
     const up=await fetch('/api/stem165?model='+encodeURIComponent(model)+'&fmt='+encodeURIComponent(fmtSel)+'&filename='+encodeURIComponent(uploadName),{method:'POST',body:uploadFile});
     const upData=await up.json().catch(()=>({}));
     if(!up.ok||!upData.job_id)throw Error(upData.error||('云端提交失败 HTTP '+up.status));
     const jobId=upData.job_id,t0=Date.now();
     let doneInfo=null;
     for(let poll=0;poll<180;poll++){
      if(job.cancelled)throw Error('已取消');
      const sec=Math.round((Date.now()-t0)/1000);
      status('☁️ 云端 GPU（'+modelName+'）正在分离中… 已耗时 '+sec+' 秒（首次冷启动约 15-30 秒）');
      prog(Math.min(78,32+Math.round(poll*1.8)));
      await new Promise(r=>setTimeout(r,1500));
      if(job.cancelled)throw Error('已取消');
      const st=await fetch('/api/stem165?job_id='+encodeURIComponent(jobId)+'&stem=status');
      const stData=await st.json().catch(()=>({}));
      if(stData.status==='done'){doneInfo=stData;break;}
      if(stData.status==='error'||!st.ok)throw Error(stData.error||'云端分离出错');
     }
     if(!doneInfo)throw Error('云端分离超时，请稍后重试');
     const ext=doneInfo.fmt==='wav'?'wav':'mp3',mime=ext==='wav'?'audio/wav':'audio/mpeg';
     status('正在拉取纯净伴奏轨（1/2）…');prog(82);
     const rInst=await fetch('/api/stem165?job_id='+encodeURIComponent(jobId)+'&stem=inst');
     if(!rInst.ok)throw Error('伴奏轨下载失败');
     const instBlob=await rInst.blob();
     status('正在拉取分离人声轨（2/2）…');prog(88);
     const rVoc=await fetch('/api/stem165?job_id='+encodeURIComponent(jobId)+'&stem=vocal');
     if(!rVoc.ok)throw Error('人声轨下载失败');
     const vocBlob=await rVoc.blob();
     const instFile=new File([instBlob],root()+'-云端伴奏.'+ext,{type:mime});
     const vocFile=new File([vocBlob],root()+'-云端人声.'+ext,{type:mime});
     status('正在将伴奏轨与人声轨载入编辑器…');
     const instSrc=await importFile(P,instFile,{cancelled:()=>job.cancelled,onProgress:p=>prog(90+Math.round(p*0.05))});
     const vocSrc=await importFile(P,vocFile,{cancelled:()=>job.cancelled,onProgress:p=>prog(95+Math.round(p*0.05))});
     P.hq3={instId:instSrc.id,vocId:vocSrc.id,info:'云端 '+modelName+' · GPU 耗时 '+(doneInfo.elapsed||'-')+'s'};
     showResult([{file:instSrc.file,name:instFile.name},{file:vocSrc.file,name:vocFile.name}],false);
     refresh();prog(100);
     status('☁️ 云端 GPU（'+modelName+'）分离完成！伴奏轨与人声轨已直接载入，点上方按钮可秒切试听或进入双轨混响精修。');
    }finally{
     if(wavOut?.opfs)await removeOPFS(wavOut.opfs);
    }
   });
  }
  case 'runHq3':{
   if(!t)return status('请先打开音频');
   if(!S.deps?.separateHQ3)return status('MDX Inst HQ3 分离模块未注入，请刷新页面');
   const quality=q('#e147Hq3Q')?.value||'standard';
   const model=q('#e147Hq3Model')?.value||'UVR-MDX-NET-Inst_HQ_3';
   const [a,b]=selRange()||[0,t];
   return task('正在运行本机 AI 人声分离',async(job,prog)=>{
    const ac=new AbortController();
    const timer=setInterval(()=>{if(job.cancelled)ac.abort();},80);
    let wavOut=null,res=null;
    try{
     status('正在准备分离音轨 WAV…');
     wavOut=await exportRange(P,a,b,{cancelled:()=>job.cancelled,onProgress:p=>prog(Math.round(p*0.08))});
     if(job.cancelled)throw Error('已取消');
     const wavFile=new File([wavOut.file],root()+'.wav',{type:'audio/wav'});
     res=await S.deps.separateHQ3(wavFile,{signal:ac.signal,quality,model,onProgress:e=>{if(e.percent!=null)prog(8+Math.round(e.percent*0.84));if(e.text)status(e.text);}});
     if(job.cancelled)throw Error('已取消');
     status('正在将分离后的伴奏与人声导入编辑器…');
     const tag=(res.modelName||'AI').replace(/\s+/g,'');
     const instFile=new File([res.instrumental],root()+'-'+tag+'伴奏.wav',{type:'audio/wav'});
     const vocFile=new File([res.vocals],root()+'-'+tag+'人声.wav',{type:'audio/wav'});
     const instSrc=await importFile(P,instFile,{cancelled:()=>job.cancelled,onProgress:p=>prog(92+Math.round(p*0.04))});
     const vocSrc=await importFile(P,vocFile,{cancelled:()=>job.cancelled,onProgress:p=>prog(96+Math.round(p*0.04))});
     P.hq3={instId:instSrc.id,vocId:vocSrc.id,info:res.engineInfo||'MDX Inst HQ3'};
     showResult([{file:instSrc.file,name:instFile.name},{file:vocSrc.file,name:vocFile.name}],false);
     refresh();prog(100);
     status(`MDX Inst HQ3 分离完成！可点上方按钮一键切伴奏/人声，或选“人声主轨+伴奏背景轨”单独给人声加混响。`);
    }finally{
     clearInterval(timer);
     if(wavOut?.opfs)await removeOPFS(wavOut.opfs);
     await res?.cleanup?.();
    }
   });
  }
  case 'hq3Inst':case 'hq3Voc':{
   const hq=P.hq3;if(!hq)return status('请先运行 MDX Inst HQ3 分离');
   const src=P.sources[k==='hq3Inst'?hq.instId:hq.vocId];if(!src)return status('分离音轨已失效，请重新分离');
   liveEdit(()=>{P.clips=[srcClip(src)];P.bg=null;S.ph=0;},false);fit();draw();
   return status(k==='hq3Inst'?'已切换为 MDX Inst HQ3 纯净伴奏（实时试听中）':'已切换为 MDX Inst HQ3 分离人声（实时试听中）');
  }
  case 'hq3Dual':{
   const hq=P.hq3;if(!hq)return status('请先运行 MDX Inst HQ3 分离');
   const vocSrc=P.sources[hq.vocId],instSrc=P.sources[hq.instId];
   if(!vocSrc||!instSrc)return status('分离音轨已失效，请重新分离');
   liveEdit(()=>{P.clips=[srcClip(vocSrc)];P.bg={src:instSrc.id,offset:0,gain:1,loop:false,duck:false,duckDb:-10};S.ph=0;},false);fit();draw();
   return status('已设为「HQ3 人声主轨 + HQ3 伴奏背景轨」：现在可单独给人声加美化混响/降噪，或在混音页微调伴奏音量');
  }
  case 'hq3DlInst':case 'hq3DlVoc':{
   const hq=P.hq3;if(!hq)return status('请先运行 AI 人声分离');
   const isInst=k==='hq3DlInst',src=P.sources[isInst?hq.instId:hq.vocId];
   if(!src)return status('分离音轨已失效，请重新分离');
   const fmtSel=q('#e147Hq3DlFmt')?.value||'mp3-192';
   const isWav=fmtSel==='wav',kbps=fmtSel==='mp3-320'?320:192,ext=isWav?'wav':'mp3';
   const label=isInst?'纯净伴奏':'分离人声';
   return task(`正在准备下载${label}（${ext.toUpperCase()}）`,async(job,prog)=>{
    let outFile=src.file;
    if(!isWav){
     const M=S.deps?.mp3||global.SongMP3134;if(!M)throw Error('MP3 编码模块未加载');
     status(`正在编码${label} MP3（${kbps} kbps）…`);
     outFile=(await M.fromWav(src.file,{kbps,cancelled:()=>job.cancelled,onProgress:prog})).file;
    }else prog(100);
    const outName=root()+'-'+label+'.'+ext;
    const u=URL.createObjectURL(outFile);S.urls.push(u);
    const a=document.createElement('a');a.href=u;a.download=outName;document.body.appendChild(a);a.click();a.remove();
    showResult([{file:outFile,name:outName}],false);
    status(`已触发下载：${outName}`);
   });
  }
  case 'hq3Zip':{
   const hq=P.hq3;if(!hq)return status('请先运行 MDX Inst HQ3 分离');
   const instSrc=P.sources[hq.instId],vocSrc=P.sources[hq.vocId];
   if(!instSrc||!vocSrc)return status('分离音轨已失效');
   return task('正在打包 HQ3 人声与伴奏 ZIP',async(job,prog)=>{
    const {zipSync}=await import('/vendor/fflate-0.8.3/esm/browser.js');
    const f=q('#e147Fmt')?.value||'mp3',kbps=Number(q('#e147Kbps')?.value)||192;
    let iFile=instSrc.file,vFile=vocSrc.file;
    if(f==='mp3'){
     const M=S.deps?.mp3||global.SongMP3134;if(!M)throw Error('MP3 编码模块未加载');
     status('正在编码伴奏 MP3（1/2）…');iFile=(await M.fromWav(instSrc.file,{kbps,cancelled:()=>job.cancelled,onProgress:p=>prog(Math.round(p*0.45))})).file;
     status('正在编码人声 MP3（2/2）…');vFile=(await M.fromWav(vocSrc.file,{kbps,cancelled:()=>job.cancelled,onProgress:p=>prog(45+Math.round(p*0.45))})).file;
    }
    status('正在打包 ZIP…');
    const zipMap={};
    zipMap[root()+'-HQ3伴奏.'+f]=new Uint8Array(await iFile.arrayBuffer());
    zipMap[root()+'-HQ3人声.'+f]=new Uint8Array(await vFile.arrayBuffer());
    const zf=new File([zipSync(zipMap,{level:0})],root()+'-HQ3人声伴奏分离.zip',{type:'application/zip'});
    showResult([{file:zf,name:zf.name}],false);prog(100);
    status('已打包下载：'+zf.name);
   });
  }
  case 'comp':{const v=btn.dataset.v||'off';liveEdit(()=>{P.comp=v;},true);return status('人声压缩器：'+(global.SongEdit161Pro?.COMP_PRESETS?.[v]?.name||v));}
  case 'chain':{
   const v=btn.dataset.v||'dry';
   const map={
    studio:{denoise:1,comp:'vocal',reverb:'vocal',reverbMix:0.9,label:'手机清唱变录音棚（轻降噪 + 流行人声压缩 + 板式混响）'},
    exam:{denoise:1,comp:'gentle',reverb:'recital',reverbMix:0.7,label:'艺考自然精修（轻降噪 + 轻度稳音压缩 + 声乐小厅）'},
    ballad:{denoise:1,comp:'vocal',reverb:'ballad',reverbMix:1.0,label:'流行抒情大片（轻降噪 + 流行人声压缩 + 抒情大片混响）'},
    dry:{denoise:0,comp:'off',reverb:'off',reverbMix:1.0,label:'已一键还原干声'}
   }[v];
   if(!map)return;
   liveEdit(()=>{P.denoise=map.denoise;P.comp=map.comp;P.reverb=map.reverb;P.reverbMix=map.reverbMix;},true);
   return status('✨ '+map.label);
  }
  case 'tunerToggle':return toggleTuner();
  case 'detectChords':{
   if(!t)return status('请先打开音频');
   if(!global.SongEdit161Pro?.detectChords)return status('和弦识别引擎未加载');
   return task('正在识别全曲和弦走向',async(job,prog)=>{
    const list=await global.SongEdit161Pro.detectChords(P,renderRange,t,{cancelled:()=>job.cancelled,onProgress:prog});
    P.chords=list;refresh();
    status(`和弦识别完成：共 ${list.length} 个和弦段，点击任意和弦块可直接从该处播放`);
   });
  }
  case 'clearChords':P.chords=null;refresh();return status('已清空和弦');
  case 'cplay':{const sec=Number(btn.dataset.t)||0;S.ph=clamp(Math.round(sec*R),0,t);return startPlay(S.ph,t,false);}
  case 'makeVideo':{
   if(!t)return status('请先打开音频');
   const [a,b]=selRange()||[0,t];
   const title=(q('#e147VidTitle')?.value||'').trim();
   const ratio=q('#e147VidRatio')?.value||'9:16';
   return task('正在生成动态波形视频',async(job,prog)=>{
    const r=await generateWaveformVideo(P,a,b,{title,ratio},job,prog);
    showResult([r],false);prog(100);
    status('🎬 动态波形视频已生成：'+r.name+'（可预览或直接下载发短视频）');
   });
  }
  case 'reverb':{const v=btn.dataset.v||'off';liveEdit(()=>{P.reverb=v;},true);return status('混响预设：'+(global.SongEdit161Pro?.REVERB_PRESETS?.[v]?.name||v));}
  case 'detectKB':{
   if(!t)return status('请先打开音频');
   if(!global.SongEdit161Pro?.analyzeKeyBpm)return status('调性/BPM 分析模块未加载');
   return task('正在分析原曲调性与 BPM',async(job,prog)=>{
    const res=await global.SongEdit161Pro.analyzeKeyBpm(P,renderRange,t,{cancelled:()=>job.cancelled,onProgress:prog});
    P.meta=res;refresh();
    status(`识别完成：原曲约 ${res.keyName}（${res.shortName}）· ${res.bpm} BPM（可一键同步到预备拍）`);
   });
  }
  case 'syncBpm':{
   if(!P.meta?.bpm)return;
   const targetBpm=clamp(Math.round(P.meta.bpm*(P.tempo||1)),40,240);
   S.tab='ins';panel();
   const inp=q('#e147CiBpm');if(inp)inp.value=String(targetBpm);
   return status(`已将 ${targetBpm} BPM 同步至“插入预备拍”，可直接点击“开头插入”`);
  }
  case 'saveTpl':{
   const tpl={pitch:P.pitch||0,formant:P.formant!==false,tempo:P.tempo||1,chMode:P.chMode||'stereo',denoise:P.denoise||0,comp:P.comp||'off',reverb:P.reverb||'off',reverbMix:P.reverbMix??1};
   try{localStorage.setItem('song147_preset_v1',JSON.stringify(tpl));status('已保存当前参数为本机常用模板');}catch(_){status('浏览器禁止写入本地存储');}
   return;
  }
  case 'loadTpl':{
   let raw=null;try{raw=localStorage.getItem('song147_preset_v1');}catch(_){}
   if(!raw)return status('还没有保存过常用模板');
   const tpl=JSON.parse(raw);
   liveEdit(()=>{P.pitch=clamp(Number(tpl.pitch)||0,-12,12);P.formant=tpl.formant!==false;P.tempo=clamp(Number(tpl.tempo)||1,0.5,1.5);P.chMode=tpl.chMode||'stereo';P.denoise=clamp(Number(tpl.denoise)||0,0,3);P.comp=tpl.comp||'off';P.reverb=tpl.reverb||'off';P.reverbMix=clamp(Number(tpl.reverbMix)||1,0.3,1.6);},true);
   return status('已一键套用常用参数模板');
  }
  case 'expJson':{
   const data={version:'v3.12.61',exportedAt:new Date().toISOString(),params:{pitch:P.pitch||0,formant:P.formant!==false,tempo:P.tempo||1,chMode:P.chMode||'stereo',denoise:P.denoise||0,reverb:P.reverb||'off'},markers:P.markers,meta:P.meta};
   const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
   const u=URL.createObjectURL(blob);S.urls.push(u);
   const a=document.createElement('a');a.href=u;a.download=root()+'-工程参数.json';a.click();
   return status('已导出工程参数 JSON');
  }
  case 'impJson':{
   const inp=document.createElement('input');inp.type='file';inp.accept='.json,application/json';
   inp.onchange=async()=>{
    const f=inp.files?.[0];if(!f)return;
    try{
     const o=JSON.parse(await f.text()),pm=o.params||o;
     liveEdit(()=>{
      if(pm.pitch!=null)P.pitch=clamp(Number(pm.pitch)||0,-12,12);
      if(pm.formant!=null)P.formant=!!pm.formant;
      if(pm.tempo!=null)P.tempo=clamp(Number(pm.tempo)||1,0.5,1.5);
      if(pm.chMode)P.chMode=pm.chMode;
      if(pm.denoise!=null)P.denoise=clamp(Number(pm.denoise)||0,0,3);
      if(pm.reverb)P.reverb=pm.reverb;
      if(Array.isArray(o.markers)&&o.markers.length&&T())P.markers=o.markers.filter(m=>m&&Number.isFinite(m.t)&&m.t>=0&&m.t<=T());
     },true);
     status('已导入工程参数并实时生效');
    }catch(e){status('工程 JSON 格式无效：'+(e?.message||e));}
   };
   inp.click();return;
  }
  case 'runBatch':{
   const inp=q('#e147BatchFiles'),files=[...(inp?.files||[])];
   if(!files.length)return status('请先选择至少 1 首音频文件');
   if(files.length>30)return status('单次批量最多支持 30 首，请分批处理');
   const stVal=clamp(Number(q('#e147BatchSt')?.value)||0,-12,12);
   const normMode=q('#e147BatchNorm')?.value||'none';
   const dnVal=clamp(Number(q('#e147BatchDn')?.value)||0,0,3);
   const revVal=q('#e147BatchRev')?.value||'off';
   const fmtSel=q('#e147BatchFmt')?.value||'mp3-192';
   const doTrim=!!q('#e147BatchTrim')?.checked;
   const doFormant=!!q('#e147BatchFormant')?.checked;
   const outExt=fmtSel==='wav'?'wav':'mp3',kbps=fmtSel==='mp3-320'?320:192;
   return task(`正在批量处理 ${files.length} 首音频`,async(job,prog)=>{
    q('#e147Result')?.replaceChildren();
    const zipMap={};
    for(let i=0;i<files.length;i++){
     if(job.cancelled)throw Error('已取消');
     const f=files[i],base=(f.name||'音频').replace(/\.[^.]+$/,'');
     status(`批量处理 ${i+1}/${files.length}：${f.name}…`);
     const tmpP=project(44100);
     tmpP.pitch=stVal;tmpP.formant=doFormant;tmpP.denoise=dnVal;tmpP.reverb=revVal;
     let outOpfs=null;
     try{
      const src=await importFile(tmpP,f,{cancelled:()=>job.cancelled,onProgress:p=>prog(Math.round((i+p*0.25/100)/files.length*95))});
      append(tmpP,[srcClip(src)]);
      if(doTrim){const tb=findTrimBounds(tmpP,-45,0.05);if(tb&&(tb.trimmedHead>tmpP.rate*0.05||tb.trimmedTail>tmpP.rate*0.05))crop(tmpP,tb.a,tb.b);}
      const tLen=total(tmpP);
      if(tLen>0&&normMode!=='none'){
       if(normMode==='peak'){const pk=await peakOf(tmpP,0,tLen,{cancelled:()=>job.cancelled});if(pk>1e-5)gain(tmpP,0,tLen,20*Math.log10(Math.pow(10,-1/20)/pk));}
       else{const tgt=normMode==='lufs16'?-16:-14,rms=await rmsOf(tmpP,0,tLen,{cancelled:()=>job.cancelled});if(rms>1e-5)gain(tmpP,0,tLen,clamp(tgt-20*Math.log10(rms),-24,24));}
      }
      const r=await exportRange(tmpP,0,total(tmpP),{cancelled:()=>job.cancelled,onProgress:p=>prog(Math.round((i+0.25+p*0.4/100)/files.length*95))});
      outOpfs=r.opfs;let finalFile=r.file;
      if(outExt==='mp3'){
       const M=S.deps?.mp3||global.SongMP3134;if(!M)throw Error('MP3 编码模块未加载');
       const m=await M.fromWav(r.file,{kbps,cancelled:()=>job.cancelled,onProgress:p=>prog(Math.round((i+0.65+p*0.35/100)/files.length*95))});
       finalFile=m.file;
      }
      const suffix=(stVal?(stVal>0?'_升':'_降')+Math.abs(stVal)+'半音':'')+(normMode!=='none'?'_'+normMode:'');
      const outName=String(i+1).padStart(2,'0')+'-'+base+suffix+'.'+outExt;
      zipMap[outName]=new Uint8Array(await finalFile.arrayBuffer());
     }finally{
      for(const s of Object.values(tmpP.sources))if(s.opfs)await removeOPFS(s.opfs);
      if(outOpfs)await removeOPFS(outOpfs);
     }
    }
    status('正在打包 ZIP 合集…');
    const {zipSync}=await import('/vendor/fflate-0.8.3/esm/browser.js');
    const zipped=zipSync(zipMap,{level:0});
    const zf=new File([zipped],`批量处理合集_${files.length}首.zip`,{type:'application/zip'});
    showResult([{file:zf,name:zf.name}],false);prog(100);
    status(`批量处理完成！已打包 ${files.length} 首为 ${zf.name}`);
   });
  }
  case 'tempo':{const v=clamp(Number(btn.dataset.v)||1,0.5,1.5);liveEdit(()=>{P.tempo=v;},true);return status('倍速已设为 '+v.toFixed(2)+'×（变速不变调）');}
  case 'pitch':{const v=clamp(Number(btn.dataset.v)||0,-12,12);liveEdit(()=>{P.pitch=v;},true);return status(v===0?'已恢复原调':'移调已设为 '+(v>0?'+':'')+v+' 半音（独立相位锁定引擎）');}
  case 'bgHere':{if(!P.bg)return;liveEdit(()=>{P.bg.offset=S.ph;},true);return status('背景轨起点已对齐到 '+fmt(S.ph));}
  case 'bgDel':{if(!P.bg)return;edit(()=>{P.bg=null;},true);return status('已移除背景轨');}
  case 'tap':{
   const now=performance.now();if(S.taps.length&&now-S.taps[S.taps.length-1]>2200)S.taps=[];
   S.taps.push(now);if(S.taps.length>8)S.taps.shift();
   if(S.taps.length>=2){
    const avg=(S.taps[S.taps.length-1]-S.taps[0])/(S.taps.length-1),bpm=clamp(Math.round(60000/avg),40,240);
    const inp=q('#e147CiBpm');if(inp)inp.value=String(bpm);
    status('点拍测速：约 '+bpm+' BPM（连续轻点 4 次更准）');
   }else status('请按节拍继续轻点“点拍测速”…');
   return;
  }
  case 'countin0':case 'countin':{
   const beats=Number(q('#e147CiBeats')?.value)||4,bpm=Number(q('#e147CiBpm')?.value)||100,at=k==='countin0'?0:S.ph;
   return task('正在生成预备拍',async()=>{
    const ci=synthCountIn(P.rate,beats,bpm);
    const src=await importPCM(P,`预备拍 ${ci.beats}拍 ${ci.bpm}BPM`,ci.L,ci.R);
    edit(()=>{insertAt(P,at,[srcClip(src)]);});
    S.ph=at;fit();draw();
    status(`已在${k==='countin0'?'开头':fmt(at)}插入 ${ci.beats} 拍预备拍（${ci.bpm} BPM）`);
   });
  }
  case 'rec':return toggleRecord();
  case 'silence':{const s=Number(q('#e147Sil').value)||1;edit(()=>insertAt(P,S.ph,[silentClip(s*R)]));return status('已在 '+fmt(S.ph)+' 插入 '+s+' 秒空白');}
  case 'cup':case 'cdown':{const i=Number(btn.dataset.i),j=k==='cup'?i-1:i+1;if(j<0||j>=P.clips.length)return;edit(()=>{const c=P.clips;[c[i],c[j]]=[c[j],c[i]];tidy(P);});return;}
  case 'cdel':{const i=Number(btn.dataset.i),{st}=layout(P),c=P.clips[i];if(!c)return;edit(()=>deleteRange(P,st[i]+(c.xf||0),st[i]+len(c)));return;}
  case 'mark':{
   let label=q('#e147Label').value;
   if(label==='__custom'){label=(prompt('标记名称','')||'').trim().slice(0,12);if(!label)return;}
   // 播放中实时打标不中断播放！
   edit(()=>{P.markers.push({t:S.ph,label});P.markers.sort((x,y)=>x.t-y.t);},true,true);
   return status('已在 '+fmt(S.ph)+' 添加「'+label+'」标记');
  }
  case 'autoMark':{
   if(!t)return status('请先打开音频');
   const gap=Number(q('#e147GapSec')?.value)||1.5,cuts=findSilenceGaps(P,-45,gap);
   if(!cuts.length)return status(`未检测到 ≥ ${gap} 秒的静音停顿`);
   edit(()=>{for(const c of cuts)P.markers.push({t:c,label:'分割'});P.markers.sort((x,y)=>x.t-y.t);},true);
   return status(`已按静音自动添加 ${cuts.length} 个“分割”标记，可直接去“导出”一键打包 ZIP`);
  }
  case 'clearMarks':if(!P.markers.length)return;edit(()=>{P.markers=[];},true);return status('已清空全部标记');
  case 'mgo':{const m=P.markers[Number(btn.dataset.i)];if(!m)return;S.ph=m.t;S.v0=m.t-S.spp*width()*0.1;clampView();return draw();}
  case 'mplay':{const m=P.markers[Number(btn.dataset.i)];if(!m)return;S.ph=m.t;return startPlay(m.t,t,false);}
  case 'mdel':{const i=Number(btn.dataset.i);edit(()=>P.markers.splice(i,1),true);return;}
  case 'cancel':if(S.busy)S.busy.cancelled=true;return status('已请求取消');
  case 'xall':if(!t)return status('请先打开音频');return task('正在导出整首',async(job,prog)=>{const r=await exportFile(0,t,'',job,prog);showResult([r]);status('导出完成：'+r.name+'（'+fmt(t)+'）');});
  case 'xsel':if(!needSel())return;{const [a,b]=selRange();return task('正在导出选区',async(job,prog)=>{const r=await exportFile(a,b,'选区'+fmt(a).replace(/[:.]/g,''),job,prog);showResult([r]);status('导出完成：'+r.name);});}
  case 'xmarks':case 'xzip':{
   const cuts=[...new Set(P.markers.map(m=>m.t).filter(x=>x>0&&x<t))].sort((x,y)=>x-y);
   if(!cuts.length)return status('请先在“标记”里添加至少一个标记');
   const bounds=[0,...cuts,t],asZip=(k==='xzip');
   return task(asZip?'正在按标记切分并打包 ZIP':'正在按标记切分导出',async(job,prog)=>{
    q('#e147Result')?.replaceChildren();
    const zipMap={};
    for(let i=0;i<bounds.length-1;i++){
     const a=bounds[i],b=bounds[i+1],m=P.markers.find(x=>x.t===a),lab=(m?m.label:'开头');
     status(`正在导出第 ${i+1}/${bounds.length-1} 段（${lab}）…`);
     const r=await exportFile(a,b,String(i+1).padStart(2,'0')+'-'+lab,job,p=>prog(Math.round((i+p/100)/(bounds.length-1)*95)));
     if(asZip)zipMap[r.name]=new Uint8Array(await r.file.arrayBuffer());
     else showResult([r],true);
    }
    if(asZip){
     status('正在本地打包 ZIP…');
     const {zipSync}=await import('/vendor/fflate-0.8.3/esm/browser.js');
     const zipped=zipSync(zipMap,{level:0});
     const zf=new File([zipped],root()+'-分段合集.zip',{type:'application/zip'});
     showResult([{file:zf,name:zf.name}],false);prog(100);
     status(`已打包 ${bounds.length-1} 个分段为 ${zf.name}`);
    }else status('已切分导出 '+(bounds.length-1)+' 段');
   });
  }
  case 'toeq':case 'topitch':if(!t)return status('请先打开音频');return task('正在生成整首 WAV',async(job,prog)=>{const r=await exportRange(P,0,t,{cancelled:()=>job.cancelled,onProgress:prog});S.outs.push(r.opfs);const f=new File([r.file],root()+'.wav',{type:'audio/wav'});const fn=k==='toeq'?S.deps?.onEQ:S.deps?.onPitch;status(k==='toeq'?'已送去 EQ 调音':'已送去升降调');fn?.(f,root());});
 }
}
function tidyKeep(P){P.clips=P.clips.filter(c=>len(c)>0);}
function mount(host,deps,open){
 S.host=host;S.deps=deps;host.innerHTML=html();panel();bindCanvas();
 host.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||!host.contains(b))return;if(b.dataset.e147Tab){S.tab=b.dataset.e147Tab;panel();return;}const k=b.dataset.e147;if(k){e.preventDefault();act(k,b).catch(err=>status('操作失败：'+(err?.message||err)));}});
 host.addEventListener('input',e=>{const t=e.target;
  if(t.id==='e147Tempo'){const out=q('#e147TempoOut');if(out)out.textContent=Number(t.value).toFixed(2)+'×';}
  else if(t.id==='e147Pitch'){const out=q('#e147PitchOut'),v=Number(t.value);if(out)out.textContent=v===0?'原调 (0)':(v>0?'+':'')+v+' 半音';}
  else if(t.id==='e147BgGain'){const out=q('#e147BgGainOut'),v=Number(t.value);if(out)out.textContent=(v>0?'+':'')+v+' dB';}
  else if(t.id==='e147RevMix'){const out=q('#e147RevMixOut');if(out)out.textContent=t.value+'%';}
 });
 host.addEventListener('change',e=>{const t=e.target;
  if(t.id==='e147Open'){const fs=[...(t.files||[])];t.value='';if(!fs.length)return;const replace=S.P.clips.length?confirm('已有正在编辑的音频。\n确定 = 清空并打开新文件\n取消 = 添加到末尾'):true;openFiles(fs,{replace});}
  else if(t.id==='e147Add'){const fs=[...(t.files||[])];t.value='';openFiles(fs,{xf:Number(q('#e147Xf')?.value)||0});}
  else if(t.id==='e147BgFile'){const f=t.files?.[0];t.value='';if(f)openBgFile(f);}
  else if(t.id==='e147VidCover'){const f=t.files?.[0];if(f){const img=new Image();img.onload=()=>{S.vidCover=img;status('已载入视频封面图');};img.src=URL.createObjectURL(f);S.urls.push(img.src);}}
  else if(t.id==='e147Tempo'){const v=clamp(Number(t.value)||1,0.5,1.5);liveEdit(()=>{S.P.tempo=v;},true);}
  else if(t.id==='e147Pitch'){const v=clamp(Number(t.value)||0,-12,12);liveEdit(()=>{S.P.pitch=v;},true);}
  else if(t.id==='e147Formant'){liveEdit(()=>{S.P.formant=t.checked;},true);}
  else if(t.id==='e147RevMix'){const v=clamp(Number(t.value)/100,0.3,1.6);liveEdit(()=>{S.P.reverbMix=v;},true);}
  else if(t.id==='e147BgGain'&&S.P.bg){const db=clamp(Number(t.value)||0,-30,6);liveEdit(()=>{S.P.bg.gain=Math.pow(10,db/20);},true);}
  else if(t.id==='e147BgOff'&&S.P.bg){const sec=Number(t.value)||0;liveEdit(()=>{S.P.bg.offset=Math.round(sec*S.P.rate);},true);}
  else if(t.id==='e147BgLoop'&&S.P.bg){liveEdit(()=>{S.P.bg.loop=t.checked;},true);}
  else if(t.id==='e147BgDuck'&&S.P.bg){liveEdit(()=>{S.P.bg.duck=t.checked;},true);}
  else if(t.id==='e147Snap')S.snap=t.checked;
  else if(['e147A','e147B','e147L'].includes(t.id)){const tt=T();let a=parseT(q('#e147A').value),b=parseT(q('#e147B').value);const L=parseT(q('#e147L').value);if(t.id==='e147L'&&Number.isFinite(a)&&Number.isFinite(L))b=a+L;if(!Number.isFinite(a))a=S.sel?.a??S.ph;if(!Number.isFinite(b))b=S.sel?.b??tt;a=clamp(a,0,tt);b=clamp(b,0,tt);S.sel=b-a>=1?{a:Math.min(a,b),b:Math.max(a,b)}:null;draw();}
  else if(t.id==='e147P'){const p=parseT(t.value);if(Number.isFinite(p))seek(p);}
 });
 const ro=new (global.ResizeObserver||class{observe(){}})(()=>{if(host.isConnected){clampView();draw();}});ro.observe(host);
 const lb=q('#e147LoopBtn');if(lb)lb.textContent='🔁 循环：'+(S.loop?'开':'关');
 if(!S.spp)fit();clampView();refresh();
 if(S.P.clips.length)status('已恢复上次的编辑内容。');
 if(open?.file){const replace=S.P.clips.length?confirm('已有正在编辑的音频。\n确定 = 清空并打开“'+(open.name||'音轨')+'”\n取消 = 添加到末尾'):true;const ext=(/\.(mp3|wav|m4a|ogg|webm)$/i.exec(open.file.name||'')||['.wav'])[0],f=open.name?new File([open.file],open.name.replace(/\.(mp3|wav|m4a|ogg|webm)$/i,'')+ext,{type:open.file.type||'audio/wav'}):open.file;openFiles([f],{replace});}
}
async function dispose(){
 stopPlay();stopTuner();cancelAnimationFrame(S.raf);
 if(S.rec){try{S.rec.mr.stop()}catch(_){}try{S.rec.stream.getTracks().forEach(tr=>tr.stop())}catch(_){}S.rec=null;}
 if(S.busy)S.busy.cancelled=true;try{await S.ctx?.close()}catch(_){}S.ctx=null;for(const u of S.urls)URL.revokeObjectURL(u);S.urls=[];
 const names=Object.values(S.P.sources).map(s=>s.opfs).filter(Boolean).concat(S.outs);S.P=project();S.sel=null;S.ph=0;S.undo=[];S.redo=[];S.board=null;S.spp=0;S.outs=[];S.host=null;for(const n of names)await removeOPFS(n);
}

const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const core={project,layout,total,slice,splitAt,resolveOverlapAt,deleteRange,copyRange,insertAt,applyRange,fade,gain,silence,crop,append,reverseRange,srcClip,silentClip,tidy,renderRange,columnPeaks,bgColumnPeaks,peakOf,rmsOf,snapZero,gainAt,findTrimBounds,findSilenceGaps,synthCountIn,createProPitchEngine,createTempoStretcher,opfsSource,clipsLength,pcm,wavHeader};
global.SongEdit147={core,importFile,importPCM,exportRange,removeOPFS,mount,dispose,get state(){return S}};
})(typeof window!=='undefined'?window:globalThis);
