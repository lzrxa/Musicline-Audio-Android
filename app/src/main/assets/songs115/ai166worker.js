/* V3.12.66 独立 ES Module AI 分离 Worker：
 * 1. 全程脱离主线程运行，彻底消除手机页面卡死与“0 秒假死”问题，取消时可秒级终止并释放全部内存。
 * 2. 自动探测 WebGPU（三星 S25 Ultra / 旗舰安卓 / 新版 iOS / 鸿蒙 / 电脑显卡），优先 GPU 硬件加速。
 * 3. 若设备不支持 WebGPU 或 GPU 推理异常，自动无缝回退至多线程 SIMD WASM（配合 COOP/COEP 启用 4 线程加速）。
 */
let libPromise=null,sep=null,activeBackend='wasm',activeThreads=1,lastCfg=null;

async function loadLib(){
 if(libPromise)return libPromise;
 libPromise=(async()=>{
  const urls=[
   'https://esm.sh/web-audio-separation@0.3.1?bundle&target=es2022',
   'https://cdn.jsdelivr.net/npm/web-audio-separation@0.3.1/+esm'
  ];
  const errors=[];
  for(const u of urls){
   try{
    const m=await import(u);
    if(typeof m.createSeparator==='function')return m;
    errors.push(u+': 缺少 createSeparator');
   }catch(e){errors.push(u+': '+(e?.message||String(e)));}
  }
  libPromise=null;
  throw Error('AI 分离库加载失败：'+errors.join(' | '));
 })();
 return libPromise;
}

async function probeWebGPU(){
 try{
  if(typeof navigator==='undefined'||!navigator.gpu||typeof navigator.gpu.requestAdapter!=='function')return false;
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'})||await navigator.gpu.requestAdapter();
  return !!adapter;
 }catch(_){return false;}
}

function configureOrt(mod){
 const threads=self.crossOriginIsolated?Math.max(1,Math.min(4,(navigator.hardwareConcurrency||4))):1;
 activeThreads=threads;
 const ort=mod?.ort||self.ort;
 try{
  if(ort?.env?.wasm){
   ort.env.wasm.simd=true;
   ort.env.wasm.numThreads=threads;
   ort.env.wasm.proxy=false;
  }
 }catch(_){}
 return threads;
}

function disposeSep(){
 try{sep?.model?.release?.();}catch(_){}
 try{sep?.dispose?.();}catch(_){}
 sep=null;
}

async function buildAndLoad(mod,cfg,providers){
 disposeSep();
 const onP=p=>{if(p)self.postMessage({type:'progress',id:cfg.activeId||0,p});};
 const x=mod.createSeparator(cfg.model,{
  common:{...(cfg.url?{modelUrl:cfg.url}:{}),onProgress:onP},
  mdx:{executionProviders:providers,batchSize:1,overlap:cfg.overlap}
 });
 if(typeof x.demix!=='function')throw Error('分离库版本不兼容（缺少 demix）');
 await x.loadModel();
 sep=x;
 activeBackend=providers[0]==='webgpu'?'webgpu':'wasm';
 return {
  primaryStemName:x.primaryStemName||'instrumental',
  compensate:Number(x.compensate)||1,
  backend:activeBackend,
  threads:activeBackend==='webgpu'?1:activeThreads,
  isolated:!!self.crossOriginIsolated,
  hfUrl:mod.MODEL_REGISTRY?.[cfg.model]?.downloadUrl||null
 };
}

self.onmessage=async e=>{
 const msg=e.data||{};
 const {id,cmd}=msg;
 try{
  if(cmd==='info'){
   const mod=await loadLib();
   const gpu=await probeWebGPU();
   const threads=configureOrt(mod);
   const hfUrl=msg.model?(mod.MODEL_REGISTRY?.[msg.model]?.downloadUrl||null):null;
   self.postMessage({id,ok:true,gpu,threads,isolated:!!self.crossOriginIsolated,hfUrl});
   return;
  }
  if(cmd==='load'){
   const mod=await loadLib();
   configureOrt(mod);
   const mode=msg.mode||'auto';
   const gpuOk=mode!=='wasm'&&(await probeWebGPU());
   lastCfg={model:msg.model,url:msg.url||null,overlap:Number(msg.overlap)||0.25,mode,activeId:id};
   let res;
   if(mode==='webgpu'){
    if(!gpuOk)throw Error('当前浏览器未开放 WebGPU，请切换为自动或多线程 WASM');
    res=await buildAndLoad(mod,lastCfg,['webgpu']);
   }else if(mode==='auto'&&gpuOk){
    try{
     self.postMessage({type:'status',id,text:'检测到 WebGPU，优先启用手机/电脑 GPU 硬件加速…'});
     res=await buildAndLoad(mod,lastCfg,['webgpu']);
    }catch(gpuErr){
     self.postMessage({type:'status',id,text:`WebGPU 初始化受限，自动切换为 ${activeThreads} 线程 SIMD WASM…`});
     res=await buildAndLoad(mod,lastCfg,['wasm']);
     res.fallbackFrom='webgpu';
    }
   }else{
    res=await buildAndLoad(mod,lastCfg,['wasm']);
   }
   self.postMessage({id,ok:true,...res});
   return;
  }
  if(cmd==='demix'){
   if(!sep)throw Error('分离模型尚未加载');
   if(lastCfg)lastCfg.activeId=id;
   let out;
   try{
    out=await sep.demix(msg.mix);
   }catch(err){
    // 若 WebGPU 在首段推理时发生显存/着色器异常，自动降级至多线程 WASM 重试一次
    if(activeBackend==='webgpu'&&lastCfg&&lastCfg.mode==='auto'){
     const mod=await loadLib();
     self.postMessage({type:'status',id,text:`WebGPU 推理回退，改用 ${activeThreads} 线程 SIMD WASM 继续分离…`});
     await buildAndLoad(mod,lastCfg,['wasm']);
     out=await sep.demix(msg.mix);
    }else throw err;
   }
   const L=out[0] instanceof Float32Array?out[0]:new Float32Array(out[0]);
   const R=out[1] instanceof Float32Array?out[1]:new Float32Array(out[1]);
   self.postMessage({id,ok:true,out:[L,R],backend:activeBackend,threads:activeBackend==='webgpu'?1:activeThreads},[L.buffer,R.buffer]);
   return;
  }
  if(cmd==='dispose'){
   disposeSep();
   self.postMessage({id,ok:true});
   return;
  }
  throw Error('未知指令：'+cmd);
 }catch(err){
  self.postMessage({id,ok:false,error:err?.message||String(err)});
 }
};
