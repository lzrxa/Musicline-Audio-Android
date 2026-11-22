/* Android local ONNX inference bridge. UI never claims success before native reports. */
(()=>{'use strict';
const $=id=>document.getElementById(id);
const native=window.NativeMdxEngine;
if(!native){$('mdxStatus').textContent='仅 Android APP 支持本地 ONNX；普通网页无法执行本机 Java 推理。';$('mdxStart').disabled=true;return;}
$('mdxStart').addEventListener('click',()=>{
 const selected=localStorage.getItem('musicline_selected_mdx')||'UVR-MDX-NET-Inst_HQ_3';
 if(!['UVR-MDX-NET-Inst_HQ_3','UVR-MDX-NET-Voc_FT'].includes(selected)){
  $('mdxStatus').textContent='当前模型尚未适配离线推理，请先选择 MDX Inst HQ3 或 MDX Vocal FT。';return;
 }
 native.selectModel(selected);native.chooseWav();
});
$('mdxProbe').addEventListener('click',()=>{
 const selected=localStorage.getItem('musicline_selected_mdx')||'UVR-MDX-NET-Inst_HQ_3';
 native.selectModel(selected);
 $('mdxStatus').textContent='正在本地加载模型并检查 ONNX 图，请不要同时开始分离…';
 $('mdxProbe').disabled=true;
 try{native.probeModel();}catch(e){$('mdxProbe').disabled=false;$('mdxStatus').textContent='预检启动失败：'+e.message;}
});
$('mdxSelfTest').addEventListener('click',()=>{
 const selected=localStorage.getItem('musicline_selected_mdx')||'UVR-MDX-NET-Inst_HQ_3';
 native.selectModel(selected);
 $('mdxStatus').textContent='开始用本地合成音频测试真实 ONNX 推理；不上传数据，也不会保留测试文件…';
 $('mdxSelfTest').disabled=true;
 try{native.selfTest();}catch(e){$('mdxSelfTest').disabled=false;$('mdxStatus').textContent='自检启动失败：'+e.message;}
});
$('mdxDiagnostics').addEventListener('click',()=>{
 try {
  const info=JSON.parse(native.diagnostics());
  $('mdxDiagnosticResult').textContent=[
   '版本：'+info.appVersion,
   '本地存储：'+(info.storageReady?'可写':'不可写'),
   'ONNX Runtime：'+(info.onnxRuntimeLoaded?'已加载':'加载失败 '+(info.runtimeError||'')),
   '可用空间：'+Math.round((info.diskFreeBytes||0)/1048576)+' MB',
   '分离任务：'+(info.exportCopying?'后台保存中':info.awaitingExport?'等待用户保存':info.taskRunning?'正在运行':'空闲'),
   '真实模型音质验证：尚未完成'
  ].join('\n');
 }catch(e){$('mdxDiagnosticResult').textContent='检查失败：'+e.message;}
});
$('mdxCancel').addEventListener('click',()=>{native.cancel();$('mdxStatus').textContent='已发出取消请求，当前分段完成后停止。';});
window.__mdxEvent=(event)=>{
 if(!event||typeof event!=='object')return;
 $('mdxProgress').value=Math.max(0,Math.min(100,event.percent||0));
 if(event.type==='probe'||event.type==='error')$('mdxProbe').disabled=false;
 if(event.type==='selftest'||event.type==='error')$('mdxSelfTest').disabled=false;
 $('mdxStatus').textContent=(event.type==='error'?'⚠️ ':event.type==='done'?'✅ ':'')+(event.message||'');
};
})();
