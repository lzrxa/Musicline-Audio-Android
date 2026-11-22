// V3.12.62 高溢价音频专业引擎：
// 1. BPM 速度与 24 大小调自动识别（Krumhansl-Schmuckler 色度轮廓 + 起音能量通量自相关）
// 2. 全新零模型频域立体声人声分离（2048-pt STFT Mid/Side 相干度 + 频段维纳软掩码，保留低音底鼓、零内存压力）
// 3. 智能人声降噪（80Hz 高通除低频嗡鸣 + 自适应底噪谱估计 + 平滑维纳频谱降噪）
// 4. 8 档专业立体声美化混响（预延迟 Pre-Delay + 早期反射 + 湿声高通防浑浊 + 8 并联阻尼梳状 + 4 串联全通流式处理器）
(function(G){
'use strict';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

// ---------- 通用 Radix-2 FFT（缓存 1024 / 2048 / 4096 旋转因子） ----------
const fftCache=new Map();
function getFftPlan(N){
 if(fftCache.has(N))return fftCache.get(N);
 const bits=Math.round(Math.log2(N)),half=N>>1;
 const rev=new Uint16Array(N),cos=new Float32Array(half),sin=new Float32Array(half),win=new Float32Array(N);
 for(let i=0;i<N;i++){
  let x=i,r=0;for(let b=0;b<bits;b++){r=(r<<1)|(x&1);x>>=1;}rev[i]=r;
  win[i]=0.5*(1-Math.cos(2*Math.PI*i/N));
 }
 for(let i=0;i<half;i++){const a=-2*Math.PI*i/N;cos[i]=Math.cos(a);sin[i]=Math.sin(a);}
 const plan={N,half,rev,cos,sin,win};fftCache.set(N,plan);return plan;
}
function runFft(re,im,plan,inv){
 const {N,rev,cos,sin}=plan;
 for(let i=0;i<N;i++){const j=rev[i];if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
 for(let len=2;len<=N;len<<=1){
  const h=len>>1,step=N/len,sgn=inv?-1:1;
  for(let i=0;i<N;i+=len){
   for(let k=0;k<h;k++){
    const idx=k*step,wr=cos[idx],wi=sin[idx]*sgn;
    const p=i+k,q=p+h,tr=re[q]*wr-im[q]*wi,ti=re[q]*wi+im[q]*wr;
    re[q]=re[p]-tr;im[q]=im[p]-ti;re[p]+=tr;im[p]+=ti;
   }
  }
 }
 if(inv){const s=1/N;for(let i=0;i<N;i++){re[i]*=s;im[i]*=s;}}
}

// ---------- 1. BPM 速度与 24 大小调识别 ----------
const NOTE_NAMES=['C','升C / 降D','D','降E','E','F','升F / 降G','G','降A','A','降B','B'];
const NOTE_SHORT=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
const KS_MAJOR=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KS_MINOR=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

function pearson(a,b){
 let ma=0,mb=0;for(let i=0;i<12;i++){ma+=a[i];mb+=b[i];}ma/=12;mb/=12;
 let num=0,da=0,db=0;
 for(let i=0;i<12;i++){const x=a[i]-ma,y=b[i]-mb;num+=x*y;da+=x*x;db+=y*y;}
 return da>1e-12&&db>1e-12?num/Math.sqrt(da*db):0;
}
function formatKey(root,mode){
 const r=((Math.round(root)%12)+12)%12;
 return NOTE_NAMES[r]+(mode==='minor'?' 小调':' 大调');
}
function transposeKeyName(root,mode,semitones){
 if(root==null)return '';
 const r=((Math.round(root+Math.round(semitones))%12)+12)%12;
 return NOTE_NAMES[r]+(mode==='minor'?' 小调':' 大调');
}

function analyzeMonoBuffer(mono,rate){
 const N=4096,plan=getFftPlan(N),re=new Float32Array(N),im=new Float32Array(N);
 const chroma=new Float64Array(12);
 const binHz=rate/N,kMin=Math.max(1,Math.floor(65/binHz)),kMax=Math.min(plan.half-1,Math.ceil(2200/binHz));
 const hopK=2048;
 for(let pos=0;pos+N<=mono.length;pos+=hopK){
  for(let i=0;i<N;i++){re[i]=mono[pos+i]*plan.win[i];im[i]=0;}
  runFft(re,im,plan,false);
  for(let k=kMin;k<=kMax;k++){
   const e=re[k]*re[k]+im[k]*im[k];if(e<1e-10)continue;
   const f=k*binHz,midi=69+12*Math.log2(f/440),pc=((Math.round(midi)%12)+12)%12;
   chroma[pc]+=Math.sqrt(e);
  }
 }
 let bestScore=-2,bestRoot=0,bestMode='major';
 for(let r=0;r<12;r++){
  const rot=new Float64Array(12);for(let i=0;i<12;i++)rot[i]=chroma[(i+r)%12];
  const sMaj=pearson(rot,KS_MAJOR),sMin=pearson(rot,KS_MINOR);
  if(sMaj>bestScore){bestScore=sMaj;bestRoot=r;bestMode='major';}
  if(sMin>bestScore){bestScore=sMin;bestRoot=r;bestMode='minor';}
 }
 const confidence=clamp((bestScore+1)/2,0,1);

 const hopB=512,fps=rate/hopB,nFrames=Math.floor(mono.length/hopB);
 let bpm=0;
 if(nFrames>fps*2){
  const rms=new Float32Array(nFrames);
  for(let f=0;f<nFrames;f++){
   let s=0;const base=f*hopB;for(let i=0;i<hopB;i++){const v=mono[base+i];s+=v*v;}
   rms[f]=Math.sqrt(s/hopB);
  }
  const flux=new Float32Array(nFrames);
  for(let f=1;f<nFrames;f++){const d=Math.log1p(120*rms[f])-Math.log1p(120*rms[f-1]);flux[f]=d>0?d:0;}
  const W=16,onset=new Float32Array(nFrames);
  for(let f=0;f<nFrames;f++){
   let s=0,c=0;const a=Math.max(0,f-W),b=Math.min(nFrames-1,f+W);
   for(let j=a;j<=b;j++){s+=flux[j];c++;}
   onset[f]=Math.max(0,flux[f]-s/c);
  }
  const lagMin=Math.max(4,Math.round(fps*60/180)),lagMax=Math.min(Math.floor(nFrames/2),Math.round(fps*60/60));
  const ac=new Float64Array(lagMax+1);
  for(let lag=lagMin;lag<=lagMax;lag++){
   let s=0;const lim=nFrames-lag;
   for(let i=0;i<lim;i++)s+=onset[i]*onset[i+lag];
   ac[lag]=s/lim;
  }
  let bestLag=Math.round(fps*60/100),bestVal=-1;
  for(let lag=lagMin;lag<=lagMax;lag++){
   const candBpm=60*fps/lag;
   const prior=Math.exp(-0.5*Math.pow(Math.log2(candBpm/112)/0.65,2));
   const harm=(lag*2<=lagMax?0.35*ac[lag*2]:0)+(Math.round(lag/2)>=lagMin?0.2*ac[Math.round(lag/2)]:0);
   const score=(ac[lag]+harm)*prior;
   if(score>bestVal){bestVal=score;bestLag=lag;}
  }
  bpm=clamp(Math.round(60*fps/bestLag),50,200);
 }
 return {root:bestRoot,mode:bestMode,keyName:formatKey(bestRoot,bestMode),shortName:NOTE_SHORT[bestRoot]+(bestMode==='minor'?'m':''),confidence,bpm};
}

async function analyzeKeyBpm(P,renderRange,totalFrames,opt={}){
 const T=totalFrames,R=P.rate;
 if(!T)throw Error('没有可分析的音频');
 const maxSec=42,start=T>R*60?Math.round(T*0.15):0,lenN=Math.min(T-start,Math.round(R*maxSec));
 const mono=new Float32Array(lenN),CH=R*8;
 let written=0;
 for(let pos=0;pos<lenN;pos+=CH){
  if(opt.cancelled?.())throw Error('已取消');
  const k=Math.min(CH,lenN-pos),d=await renderRange(P,start+pos,k);
  for(let i=0;i<k;i++)mono[written+i]=(d[0][i]+d[1][i])*0.5;
  written+=k;
  opt.onProgress?.(Math.min(90,Math.round(written/lenN*90)));
  await new Promise(r=>setTimeout(r,0));
 }
 const res=analyzeMonoBuffer(mono,R);
 opt.onProgress?.(100);
 return res;
}

// ---------- 2. 增强版零模型人声分离（2048-pt STFT + HPSS 谐波/打击乐中值分离 + 瞬态护鼓 + Mid/Side 维纳软掩码） ----------
const VOCAL_SEP_MODES={
 off:{name:'关（原曲）'},
 inst:{name:'纯净伴奏（HPSS 护鼓·保低音）'},
 vocal:{name:'提取人声（谐波聚焦·去鼓点）'},
 karaoke:{name:'强力消原唱（KTV 护鼓伴奏）'}
};
function vocalBandWeight(freq){
 // 95 Hz 以下为底鼓与贝斯区（不作人声剔除，100% 保留浑厚低音）
 if(freq<95)return 0;
 if(freq<150)return (freq-95)/55;
 if(freq<=6500)return 1;
 if(freq<10800)return 1-(freq-6500)/4300;
 return 0;
}
function medianSmall(arr,len){
 // 原地插入排序小数组（长度 <= 13，零 GC 分配）
 for(let i=1;i<len;i++){const v=arr[i];let j=i-1;while(j>=0&&arr[j]>v){arr[j+1]=arr[j];j--;}arr[j+1]=v;}
 return arr[len>>1];
}
function applyVocalSep(L,R,rate,mode){
 if(!mode||mode==='off')return [L,R];
 const n=L.length;if(n<2048)return [L,R];
 const N=2048,hop=512,plan=getFftPlan(N),half=plan.half,binHz=rate/N,bins=half+1;
 const bandW=new Float32Array(bins);
 for(let k=0;k<bins;k++)bandW[k]=vocalBandWeight(k*binHz);

 const nFrames=Math.max(1,Math.floor((n-N)/hop)+1);
 const reL=new Float32Array(N),imL=new Float32Array(N),reR=new Float32Array(N),imR=new Float32Array(N);
 const invSqrt2=Math.SQRT1_2;

 // Pass 1: 计算全部帧的 Mid/Side 复数谱与 Mid 幅度谱（用于 2D HPSS 中值滤波与频谱通量瞬态检测）
 const mReAll=new Float32Array(nFrames*bins),mImAll=new Float32Array(nFrames*bins);
 const sReAll=new Float32Array(nFrames*bins),sImAll=new Float32Array(nFrames*bins);
 const magM=new Float32Array(nFrames*bins),panAll=new Float32Array(nFrames*bins);
 const flux=new Float32Array(nFrames);

 for(let f=0;f<nFrames;f++){
  const base=f*hop,row=f*bins;
  for(let i=0;i<N;i++){const w=plan.win[i];reL[i]=L[base+i]*w;imL[i]=0;reR[i]=R[base+i]*w;imR[i]=0;}
  runFft(reL,imL,plan,false);runFft(reR,imR,plan,false);
  let fl=0;
  for(let k=0;k<bins;k++){
   const mRe=(reL[k]+reR[k])*invSqrt2,mIm=(imL[k]+imR[k])*invSqrt2;
   const sRe=(reL[k]-reR[k])*invSqrt2,sIm=(imL[k]-imR[k])*invSqrt2;
   mReAll[row+k]=mRe;mImAll[row+k]=mIm;sReAll[row+k]=sRe;sImAll[row+k]=sIm;
   const eM=mRe*mRe+mIm*mIm,eS=sRe*sRe+sIm*sIm,mm=Math.sqrt(eM);
   magM[row+k]=mm;
   panAll[row+k]=clamp((eM-eS)/(eM+eS+1e-12),0,1);
   if(f>0&&bandW[k]>0){const d=mm-magM[(f-1)*bins+k];if(d>0)fl+=d;}
  }
  flux[f]=fl;
 }

 // 瞬态保护系数（检测军鼓/底鼓/钢琴强起音，避免消原唱时把鼓点“吸扁”）
 const transProt=new Float32Array(nFrames),tmpBuf=new Float32Array(15);
 for(let f=0;f<nFrames;f++){
  let c=0;for(let df=-4;df<=4;df++){const ff=clamp(f+df,0,nFrames-1);tmpBuf[c++]=flux[ff];}
  const med=medianSmall(tmpBuf,c)+1e-7;
  const ratio=flux[f]/med;
  transProt[f]=ratio>1.8?clamp((ratio-1.8)/2.2,0,1):0;
 }

 // Pass 2: 2D HPSS 中值滤波（时间轴 9 帧提取谐波 H，频率轴 13 频点提取打击乐 P）+ 合成输出
 const outL=new Float32Array(n),outR=new Float32Array(n),winSum=new Float32Array(n);
 const vMask=new Float32Array(bins),smMask=new Float32Array(bins);
 const panPow=mode==='karaoke'?1.25:(mode==='vocal'?2.05:1.65);

 for(let f=0;f<nFrames;f++){
  const row=f*bins,tp=transProt[f];
  for(let k=0;k<bins;k++){
   const bw=bandW[k];
   if(bw<=0){vMask[k]=0;continue;}
   // 时间中值 -> 谐波能量 H（持续人声/弦乐）
   let ct=0;for(let df=-4;df<=4;df++){tmpBuf[ct++]=magM[clamp(f+df,0,nFrames-1)*bins+k];}
   const H=medianSmall(tmpBuf,ct);
   // 频率中值 -> 打击乐能量 P（宽带军鼓/踩镲瞬态）
   let cf=0;for(let dk=-6;dk<=6;dk++){tmpBuf[cf++]=magM[row+clamp(k+dk,0,half)];}
   const P=medianSmall(tmpBuf,cf);
   const h2=H*H,p2=P*P,harmProb=h2/(h2+p2+1e-12);
   // 人声高度偏谐波；打击乐瞬态 harmProb 趋近 0 且受 transProt 额外保护
   const harmW=mode==='vocal'?(0.08+0.92*harmProb):(0.18+0.82*harmProb);
   const tScale=1-0.48*tp*(1-0.5*harmProb);
   vMask[k]=clamp(Math.pow(panAll[row+k],panPow)*bw*harmW*tScale,0,1);
  }
  smMask[0]=vMask[0];smMask[half]=vMask[half];
  for(let k=1;k<half;k++)smMask[k]=0.2*vMask[k-1]+0.6*vMask[k]+0.2*vMask[k+1];

  for(let k=0;k<bins;k++){
   const mRe=mReAll[row+k],mIm=mImAll[row+k],sRe=sReAll[row+k],sIm=sImAll[row+k],vm=smMask[k];
   let oMRe,oMIm,oSRe,oSIm;
   if(mode==='vocal'){
    const gM=vm,gS=vm*0.16;
    oMRe=mRe*gM;oMIm=mIm*gM;oSRe=sRe*gS;oSIm=sIm*gS;
   }else{
    const att=mode==='karaoke'?0.99:0.94;
    const gM=1-vm*att,boostS=1+0.10*vm;
    oMRe=mRe*gM;oMIm=mIm*gM;oSRe=sRe*boostS;oSIm=sIm*boostS;
   }
   reL[k]=(oMRe+oSRe)*invSqrt2;imL[k]=(oMIm+oSIm)*invSqrt2;
   reR[k]=(oMRe-oSRe)*invSqrt2;imR[k]=(oMIm-oSIm)*invSqrt2;
   if(k>0&&k<half){reL[N-k]=reL[k];imL[N-k]=-imL[k];reR[N-k]=reR[k];imR[N-k]=-imR[k];}
  }
  runFft(reL,imL,plan,true);runFft(reR,imR,plan,true);
  const base=f*hop;
  for(let i=0;i<N;i++){const w=plan.win[i];outL[base+i]+=reL[i]*w;outR[base+i]+=reR[i]*w;winSum[base+i]+=w*w;}
 }
 for(let i=0;i<n;i++){
  if(winSum[i]>1e-5){outL[i]/=winSum[i];outR[i]/=winSum[i];}
  else{outL[i]=L[i];outR[i]=R[i];}
 }
 return [outL,outR];
}

// ---------- 3. 流式智能人声降噪（跨分段状态连续：80Hz 高通 + 滑窗 COLA STFT + 自适应底噪追踪，零接缝爆音） ----------
const DENOISE_LEVELS={
 0:{name:'关',overSub:0,floor:1,maxNoise:0},
 1:{name:'轻度（空调/电流底噪）',overSub:1.10,floor:0.22,maxNoise:0.04},
 2:{name:'中度（环境杂音）',overSub:1.55,floor:0.13,maxNoise:0.08},
 3:{name:'强力（嘈杂教室）',overSub:2.05,floor:0.07,maxNoise:0.14}
};
function createHP80(rate){
 const w0=2*Math.PI*Math.min(80,rate*0.1)/rate,cs=Math.cos(w0),sn=Math.sin(w0),al=sn/(2*0.7071);
 const a0=1+al,b0=(1+cs)/2/a0,b1=-(1+cs)/a0,b2=(1+cs)/2/a0,a1=-2*cs/a0,a2=(1-al)/a0;
 let x1=0,x2=0,y1=0,y2=0;
 return x=>{const y=b0*x+b1*x1+b2*x2-a1*y1-a2*y2;x2=x1;x1=x;y2=y1;y1=y;return y;};
}
function createDenoiseProcessor(rate,level){
 const cfg=DENOISE_LEVELS[level];
 if(!cfg||!level)return {process(L,R){return [L,R];}};
 const N=1024,hop=256,plan=getFftPlan(N),half=plan.half,colaInv=1/1.5; // 75% Hann^2 精确常数 COLA = 1.5
 const hpL=createHP80(rate),hpR=createHP80(rate);
 // 每个声道维护连续输入滑窗、输出重叠相加缓冲与平滑底噪谱（跨分段完全连续，零咔嗒声）
 function makeCh(){
  return {
   inBuf:new Float32Array(N),inFill:N-hop,
   ola:new Float32Array(N),
   re:new Float32Array(N),im:new Float32Array(N),
   noise:new Float32Array(half+1).fill(-1),
   gPrev:new Float32Array(half+1).fill(1),
   gRaw:new Float32Array(half+1),gSm:new Float32Array(half+1),
   outQ:new Float32Array(hop)
  };
 }
 const chL=makeCh(),chR=makeCh();
 const maxNoiseMag=cfg.maxNoise*N*0.25;

 function stepFrame(st){
  for(let i=0;i<N;i++){st.re[i]=st.inBuf[i]*plan.win[i];st.im[i]=0;}
  runFft(st.re,st.im,plan,false);
  for(let k=0;k<=half;k++){
   const mag=Math.hypot(st.re[k],st.im[k]);
   // 自适应底噪追踪：向下快速贴近真实底噪，向上极慢漂移且封顶，绝不把持续人声误当噪声
   if(st.noise[k]<0)st.noise[k]=Math.min(mag,maxNoiseMag);
   else if(mag<st.noise[k])st.noise[k]=0.82*st.noise[k]+0.18*mag;
   else st.noise[k]=Math.min(maxNoiseMag,st.noise[k]*1.0012+1e-7);
   const ratio=st.noise[k]/(mag+1e-7);
   const targetG=clamp(1-cfg.overSub*Math.pow(Math.min(2,ratio),1.45),cfg.floor,1);
   // 时域平滑增益（消除水波纹与爆破瞬态）
   st.gPrev[k]=targetG>st.gPrev[k]?(0.55*st.gPrev[k]+0.45*targetG):(0.78*st.gPrev[k]+0.22*targetG);
   st.gRaw[k]=st.gPrev[k];
  }
  st.gSm[0]=st.gRaw[0];st.gSm[half]=st.gRaw[half];
  for(let k=1;k<half;k++)st.gSm[k]=0.2*st.gRaw[k-1]+0.6*st.gRaw[k]+0.2*st.gRaw[k+1];
  for(let k=0;k<=half;k++){
   const g=st.gSm[k];st.re[k]*=g;st.im[k]*=g;
   if(k>0&&k<half){st.re[N-k]=st.re[k];st.im[N-k]=-st.im[k];}
  }
  runFft(st.re,st.im,plan,true);
  for(let i=0;i<N;i++)st.ola[i]+=st.re[i]*plan.win[i];
  const block=new Float32Array(hop);
  for(let i=0;i<hop;i++)block[i]=st.ola[i]*colaInv;
  st.ola.copyWithin(0,hop,N);st.ola.fill(0,N-hop);
  return block;
 }

 function procCh(st,hp,inp){
  const n=inp.length,out=new Float32Array(n);
  // 维持恒定 N-hop 预填充实现严格连续流式输出
  let outPos=0;
  // 先吐出上次剩余的 outQ
  if(st.outQ.length){
   const k=Math.min(n,st.outQ.length);
   out.set(st.outQ.subarray(0,k),0);outPos+=k;
   st.outQ=st.outQ.subarray(k);
  }
  for(let i=0;i<n;i++){
   const s=hp(inp[i]);
   if(st.inFill<N){
    st.inBuf[st.inFill++]=s;
    if(st.inFill===N){
     const blk=stepFrame(st);
     st.inBuf.copyWithin(0,hop,N);st.inFill=N-hop;
     const avail=Math.min(n-outPos,hop);
     if(avail>0){out.set(blk.subarray(0,avail),outPos);outPos+=avail;}
     if(avail<hop){
      const nextQ=new Float32Array(st.outQ.length+(hop-avail));
      nextQ.set(st.outQ);nextQ.set(blk.subarray(avail),st.outQ.length);st.outQ=nextQ;
     }
    }
   }
  }
  return out;
 }

 return {
  level,
  process(L,R){
   return [procCh(chL,hpL,L),procCh(chR,hpR,R)];
  }
 };
}
function applyDenoise(L,R,rate,level){
 return createDenoiseProcessor(rate,level).process(L,R);
}

// ---------- 4. 8 档专业立体声美化混响（Pre-Delay + 早期反射 + 湿声高通防浑浊 + Freeverb） ----------
const REVERB_PRESETS={
 off:{name:'关（原干声）',room:0,damp:0,wet:0,dry:1,preMs:0,er:0,spread:23,bright:0},
 studio:{name:'温暖录音棚',room:0.62,damp:0.56,wet:0.16,dry:0.96,preMs:12,er:0.14,spread:23,bright:-0.1},
 vocal:{name:'流行人声板式',room:0.75,damp:0.34,wet:0.22,dry:0.94,preMs:22,er:0.18,spread:31,bright:0.22},
 recital:{name:'声乐小厅',room:0.79,damp:0.42,wet:0.24,dry:0.92,preMs:18,er:0.24,spread:27,bright:0.05},
 ballad:{name:'抒情大片',room:0.86,damp:0.36,wet:0.29,dry:0.90,preMs:30,er:0.20,spread:39,bright:0.14},
 hall:{name:'金色音乐厅',room:0.89,damp:0.32,wet:0.31,dry:0.88,preMs:34,er:0.26,spread:43,bright:0.08},
 cathedral:{name:'空灵圣堂',room:0.93,damp:0.24,wet:0.36,dry:0.85,preMs:45,er:0.22,spread:53,bright:0.18},
 ktv:{name:'专业 KTV 包厢',room:0.70,damp:0.46,wet:0.26,dry:0.93,preMs:26,er:0.30,spread:35,bright:0.10},
 dream:{name:'梦幻宽广',room:0.91,damp:0.18,wet:0.34,dry:0.86,preMs:38,er:0.25,spread:61,bright:0.28}
};
const COMB_BASE=[1116,1188,1277,1356,1422,1491,1557,1617];
const ALLPASS_BASE=[556,441,341,225];

function createReverbProcessor(rate,presetKey,wetScale=1){
 const p=REVERB_PRESETS[presetKey]||REVERB_PRESETS.off;
 const mixScale=clamp(Number(wetScale)||1,0.1,1.8);
 if(!p.wet)return {process(L,R){return [L,R];}};
 const scale=rate/44100;
 function makeChannel(spread){
  const combs=COMB_BASE.map(n=>({buf:new Float32Array(Math.max(16,Math.round((n+spread)*scale))),idx:0,store:0}));
  const alls=ALLPASS_BASE.map(n=>({buf:new Float32Array(Math.max(8,Math.round((n+spread)*scale))),idx:0}));
  return {combs,alls};
 }
 const chL=makeChannel(0),chR=makeChannel(p.spread||23);
 // 预延迟 + 早期反射（让主唱字头清晰干净，混响尾音在 12~45ms 后丝滑展开）
 const preLen=Math.max(4,Math.round((p.preMs||12)*0.001*rate)+1);
 const erMax=Math.max(preLen+8,Math.round(0.065*rate));
 const preBuf=new Float32Array(erMax);
 let preIdx=0;
 const erL1=Math.round(0.013*rate),erL2=Math.round(0.029*rate),erL3=Math.round(0.047*rate);
 const erR1=Math.round(0.017*rate),erR2=Math.round(0.034*rate),erR3=Math.round(0.053*rate);
 // 湿声 140Hz 一阶高通（防止低频混响发闷）+ 高频空气感微提
 const hpAlpha=Math.exp(-2*Math.PI*140/rate);
 let hpX=0,hpY=0,airPrevL=0,airPrevR=0;

 const fb=p.room,d1=p.damp,d2=1-d1,wet=p.wet*mixScale,dry=p.dry,erGain=(p.er||0)*mixScale,bright=p.bright||0,inGain=0.016;
 function tickCh(ch,x){
  let out=0;
  for(let i=0;i<8;i++){
   const c=ch.combs[i],b=c.buf,o=b[c.idx];
   c.store=o*d2+c.store*d1;
   b[c.idx]=x+c.store*fb;
   if(++c.idx>=b.length)c.idx=0;
   out+=o;
  }
  for(let i=0;i<4;i++){
   const a=ch.alls[i],b=a.buf,o=b[a.idx];
   b[a.idx]=out+o*0.5;
   out=o-out;
   if(++a.idx>=b.length)a.idx=0;
  }
  return out;
 }
 return {
  preset:presetKey,
  process(L,R){
   const n=L.length,oL=new Float32Array(n),oR=new Float32Array(n);
   for(let i=0;i<n;i++){
    const mono=(L[i]+R[i])*0.5;
    // 湿声高通滤波去闷
    hpY=hpAlpha*(hpY+mono-hpX);hpX=mono;
    preBuf[preIdx]=hpY;
    const delayed=preBuf[(preIdx-preLen+erMax)%erMax];
    const erL=(preBuf[(preIdx-erL1+erMax)%erMax]*0.55+preBuf[(preIdx-erL2+erMax)%erMax]*0.32+preBuf[(preIdx-erL3+erMax)%erMax]*0.18)*erGain;
    const erR=(preBuf[(preIdx-erR1+erMax)%erMax]*0.55+preBuf[(preIdx-erR2+erMax)%erMax]*0.32+preBuf[(preIdx-erR3+erMax)%erMax]*0.18)*erGain;
    if(++preIdx>=erMax)preIdx=0;

    let wL=tickCh(chL,delayed*inGain)*wet+erL;
    let wR=tickCh(chR,delayed*inGain)*wet+erR;
    if(bright!==0){
     const hiL=wL-airPrevL;airPrevL=wL;wL+=hiL*bright;
     const hiR=wR-airPrevR;airPrevR=wR;wR+=hiR*bright;
    }
    oL[i]=L[i]*dry+wL;
    oR[i]=R[i]*dry+wR;
   }
   return [oL,oR];
  }
 };
}
function applyReverb(L,R,rate,presetKey,wetScale=1){
 return createReverbProcessor(rate,presetKey,wetScale).process(L,R);
}


// ---------- 5. 立体声联动软拐点人声压缩器（带柔和防削波限幅，彻底杜绝爆音） ----------
const COMP_PRESETS={
 off:{name:'关',th:0,ratio:1,knee:0,att:10,rel:120,makeup:0},
 gentle:{name:'轻度稳音（艺考/自然）',th:-18,ratio:2.2,knee:8,att:6,rel:150,makeup:2.0},
 vocal:{name:'流行人声紧实（防爆音）',th:-20,ratio:3.2,knee:8,att:4,rel:130,makeup:3.5},
 master:{name:'母带饱满响度',th:-14,ratio:2.6,knee:6,att:5,rel:160,makeup:2.5}
};
function createCompressorProcessor(rate,presetKey){
 const p=COMP_PRESETS[presetKey]||COMP_PRESETS.off;
 if(!p||presetKey==='off'||p.ratio<=1)return {process(L,R){return [L,R];}};
 const attC=Math.exp(-1/(p.att*0.001*rate)),relC=Math.exp(-1/(p.rel*0.001*rate));
 const gSmoothC=Math.exp(-1/(0.004*rate)); // 4ms 增益平滑，杜绝瞬态咔嗒
 const makeupLin=Math.pow(10,p.makeup/20),halfK=p.knee/2,invSlope=1/p.ratio-1;
 let envDb=-60,smoothG=1;
 const ceilKnee=0.86,ceilMax=0.96;
 return {
  preset:presetKey,
  process(L,R){
   const n=L.length,oL=new Float32Array(n),oR=new Float32Array(n);
   for(let i=0;i<n;i++){
    const pk=Math.max(Math.abs(L[i]),Math.abs(R[i]),1e-6);
    const inDb=20*Math.log10(pk);
    envDb=inDb>envDb?(attC*envDb+(1-attC)*inDb):(relC*envDb+(1-relC)*inDb);
    let grDb=0;
    const over=envDb-p.th;
    if(p.knee>0&&over>-halfK&&over<halfK){
     const x=over+halfK;grDb=invSlope*x*x/(2*p.knee);
    }else if(over>=halfK){
     grDb=invSlope*over;
    }
    const targetG=Math.pow(10,grDb/20)*makeupLin;
    smoothG=gSmoothC*smoothG+(1-gSmoothC)*targetG;
    let l=L[i]*smoothG,r=R[i]*smoothG;
    // 立体声联动柔和限幅（防止增益补偿后超过 0 dBFS 触发数字削波爆破声）
    const outPk=Math.max(Math.abs(l),Math.abs(r));
    if(outPk>ceilKnee){
     const lim=(ceilKnee+(ceilMax-ceilKnee)*Math.tanh((outPk-ceilKnee)/(ceilMax-ceilKnee)))/outPk;
     l*=lim;r*=lim;
    }
    oL[i]=l;oR[i]=r;
   }
   return [oL,oR];
  }
 };
}

// ---------- 6. YIN 实时基频与音准检测（±1 音分精度，65Hz - 1200Hz） ----------
const H_UP=['C','#C','D','♭E','E','F','#F','G','♭A','A','♭B','B'];
const H_LO=['c','#c','d','♭e','e','f','#f','g','♭a','a','♭b','b'];
const H_SUP=['','¹','²','³','⁴','⁵'],H_SUB=['','₁','₂','₃'];
function midiToHelmholtz(m){
 const r=Math.round(m),pc=((r%12)+12)%12,spn=Math.floor(r/12)-1;
 if(spn>=4)return H_LO[pc]+(H_SUP[spn-3]||String(spn-3));
 if(spn===3)return H_LO[pc];
 if(spn===2)return H_UP[pc];
 const sub=2-spn;return H_UP[pc]+(H_SUB[sub]||String(sub));
}
function detectPitchYIN(buf,rate){
 const n=buf.length,half=Math.min(Math.floor(n/2),Math.ceil(rate/60));
 if(half<32)return null;
 let rms=0;for(let i=0;i<n;i++)rms+=buf[i]*buf[i];
 rms=Math.sqrt(rms/n);
 if(rms<0.008)return null; // 静音阈值
 const minTau=Math.max(8,Math.floor(rate/1250)),maxTau=Math.min(half-2,Math.ceil(rate/62));
 const diff=new Float32Array(maxTau+2);
 for(let tau=1;tau<=maxTau;tau++){
  let s=0;const lim=n-tau;
  for(let i=0;i<lim;i++){const d=buf[i]-buf[i+tau];s+=d*d;}
  diff[tau]=s;
 }
 const cmnd=new Float32Array(maxTau+2);cmnd[0]=1;
 let runSum=0,bestTau=-1;
 for(let tau=1;tau<=maxTau;tau++){
  runSum+=diff[tau];
  cmnd[tau]=runSum>1e-12?(diff[tau]*tau/runSum):1;
 }
 for(let tau=minTau;tau<=maxTau;tau++){
  if(cmnd[tau]<0.16){
   while(tau+1<=maxTau&&cmnd[tau+1]<cmnd[tau])tau++;
   bestTau=tau;break;
  }
 }
 if(bestTau<0){
  let mv=1;
  for(let tau=minTau;tau<=maxTau;tau++)if(cmnd[tau]<mv){mv=cmnd[tau];bestTau=tau;}
  if(mv>0.32||bestTau<0)return null;
 }
 // 抛物线插值精化周期
 const y0=cmnd[Math.max(1,bestTau-1)],y1=cmnd[bestTau],y2=cmnd[Math.min(maxTau,bestTau+1)];
 const denom=2*(y0-2*y1+y2);
 const shift=Math.abs(denom)>1e-9?(y0-y2)/denom:0;
 const freq=rate/(bestTau+clamp(shift,-0.5,0.5));
 if(!Number.isFinite(freq)||freq<60||freq>1300)return null;
 const midi=69+12*Math.log2(freq/440);
 const midiRound=Math.round(midi);
 const cents=Math.round((midi-midiRound)*100);
 const pc=((midiRound%12)+12)%12,oct=Math.floor(midiRound/12)-1;
 return {freq,midi,note:midiToHelmholtz(midiRound),pc,oct,cents,rms,clarity:clamp(1-cmnd[bestTau],0,1)};
}

// ---------- 7. 自动和弦识别（36 种大三/小三/属七和弦模板 + 时序平滑） ----------
const CHORD_TPL=[];
for(let r=0;r<12;r++){
 const maj=new Float32Array(12);maj[r]=1;maj[(r+4)%12]=0.85;maj[(r+7)%12]=0.9;
 CHORD_TPL.push({root:r,type:'',name:NOTE_SHORT[r],v:maj});
 const min=new Float32Array(12);min[r]=1;min[(r+3)%12]=0.85;min[(r+7)%12]=0.9;
 CHORD_TPL.push({root:r,type:'m',name:NOTE_SHORT[r]+'m',v:min});
 const dom=new Float32Array(12);dom[r]=1;dom[(r+4)%12]=0.82;dom[(r+7)%12]=0.85;dom[(r+10)%12]=0.72;
 CHORD_TPL.push({root:r,type:'7',name:NOTE_SHORT[r]+'7',v:dom});
}
function transposeChordName(root,type,semitones){
 const r=((Math.round(root+Math.round(semitones))%12)+12)%12;
 return NOTE_SHORT[r]+(type||'');
}
function detectChordsFromMono(mono,rate){
 const N=4096,plan=getFftPlan(N),re=new Float32Array(N),im=new Float32Array(N);
 const binHz=rate/N,kMin=Math.max(1,Math.floor(75/binHz)),kMax=Math.min(plan.half-1,Math.ceil(2000/binHz));
 const stepFrames=Math.round(rate*1.0); // 每 1.0 秒分析一个小节窗
 const raw=[];
 for(let pos=0;pos+N<=mono.length;pos+=stepFrames){
  const chroma=new Float64Array(12);
  let subCnt=0;
  for(let sub=0;sub<3;sub++){
   const p=pos+sub*Math.floor((stepFrames-N)/3);
   if(p<0||p+N>mono.length)continue;
   for(let i=0;i<N;i++){re[i]=mono[p+i]*plan.win[i];im[i]=0;}
   runFft(re,im,plan,false);
   for(let k=kMin;k<=kMax;k++){
    const e=re[k]*re[k]+im[k]*im[k];if(e<1e-9)continue;
    const f=k*binHz,midi=69+12*Math.log2(f/440),pc=((Math.round(midi)%12)+12)%12;
    chroma[pc]+=Math.sqrt(e);
   }
   subCnt++;
  }
  let norm=0;for(let i=0;i<12;i++)norm+=chroma[i]*chroma[i];
  if(norm<1e-6){raw.push({t:pos/rate,root:-1,type:'',name:'N.C.'});continue;}
  norm=Math.sqrt(norm);
  let best=CHORD_TPL[0],bestScore=-1;
  for(const tpl of CHORD_TPL){
   let dot=0,tn=0;for(let i=0;i<12;i++){dot+=chroma[i]*tpl.v[i];tn+=tpl.v[i]*tpl.v[i];}
   const sc=dot/(norm*Math.sqrt(tn));
   if(sc>bestScore){bestScore=sc;best=tpl;}
  }
  raw.push({t:pos/rate,root:best.root,type:best.type,name:best.name});
 }
 // 合并连续相同和弦
 const merged=[];
 for(let i=0;i<raw.length;i++){
  const cur=raw[i],end=(i+1<raw.length?raw[i+1].t:mono.length/rate);
  const prev=merged[merged.length-1];
  if(prev&&prev.name===cur.name)prev.end=end;
  else merged.push({...cur,end});
 }
 return merged;
}
async function detectChords(P,renderRange,totalFrames,opt={}){
 const T=totalFrames,R=P.rate;
 if(!T)throw Error('没有可分析的音频');
 const lenN=Math.min(T,Math.round(R*300)); // 最多分析前 5 分钟
 const mono=new Float32Array(lenN),CH=R*10;
 for(let pos=0;pos<lenN;pos+=CH){
  if(opt.cancelled?.())throw Error('已取消');
  const k=Math.min(CH,lenN-pos),d=await renderRange(P,pos,k);
  for(let i=0;i<k;i++)mono[pos+i]=(d[0][i]+d[1][i])*0.5;
  opt.onProgress?.(Math.min(90,Math.round((pos+k)/lenN*90)));
  await new Promise(r=>setTimeout(r,0));
 }
 const list=detectChordsFromMono(mono,R);
 opt.onProgress?.(100);
 return list;
}

G.SongEdit161Pro={
 analyzeKeyBpm,analyzeMonoBuffer,transposeKeyName,formatKey,
 applyVocalSep,VOCAL_SEP_MODES,
 createDenoiseProcessor,applyDenoise,DENOISE_LEVELS,
 createReverbProcessor,applyReverb,REVERB_PRESETS,
 createCompressorProcessor,COMP_PRESETS,
 detectPitchYIN,midiToHelmholtz,detectChords,detectChordsFromMono,transposeChordName
};
})(typeof window!=='undefined'?window:globalThis);
