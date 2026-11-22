/* Musicline native model library. Native private files survive app relaunch/update.
   This component manages model weights only, not DSP/ONNX inference. */
(()=>{'use strict';
 const $=id=>document.getElementById(id);
 const STORE=window.NativeModelStore;
 const rows=[
  {id:'UVR-MDX-NET-Inst_HQ_3',name:'MDX Inst HQ3',note:'伴奏优化 · 推荐',mb:'约 67 MB'},
  {id:'UVR-MDX-NET-Voc_FT',name:'MDX Vocal FT',note:'提取完整人声',mb:'约 67 MB'},
  {id:'Kim_Vocal_2',name:'Kim Vocal 2',note:'人声对比',mb:'约 67 MB'},
  {id:'UVR_MDXNET_KARA_2',name:'MDX Karaoke',note:'去主唱、保留和声',mb:'约 53 MB'},
  {id:'UVR_MDXNET_Main',name:'MDX Main',note:'基础模型对比',mb:'约 67 MB'}
 ];
 const state={models:[],activeId:null,freeBytes:0,inferenceReady:false};
 let selected=localStorage.getItem('musicline_selected_mdx')||'UVR-MDX-NET-Inst_HQ_3';
 const message=text=>{$('modelMessage').textContent=String(text||'');};
 const fmt=n=>n?((n/1024/1024).toFixed(1)+' MB'):'—';
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function render(){
  if(!STORE){$('modelNativeWarn').textContent='请通过安卓 APP 打开本页面；普通浏览器不提供本地模型管理接口。';$('modelList').replaceChildren();return;}
  $('modelNativeWarn').textContent='模型文件保存在应用私有存储：不依赖浏览器缓存，不会被常规缓存清理删除。';
  const html=rows.map(row=>{const info=state.models.find(m=>m.id===row.id)||{};
   const ready=!!info.downloaded,active=state.activeId===row.id,busy=!!state.activeId,isSelected=selected===row.id;
   return `<div class="model" data-model="${esc(row.id)}"><strong>${esc(row.name)} ${isSelected?'⭐ 当前选择':''} ${ready?'✅ 已下载':'⬇ 未下载'}</strong>
    <small>${esc(row.note)} · ${fmt(info.bytes)||row.mb} · ${ready?'断网可读取':'需首次联网或导入文件'}</small>
    <div class="grid"><button type="button" class="go" data-cmd="download" ${ready||busy?'disabled':''}>${ready?'已保存在本地':'下载模型'}</button>
    <button type="button" class="soft" data-cmd="import" ${busy?'disabled':''}>导入已有 ONNX</button></div>
    <button type="button" class="soft" data-cmd="select">${isSelected?'当前选择':'选择此模型'}</button>
    <button type="button" class="soft" data-cmd="delete" ${!ready||busy?'disabled':''}>删除本地模型</button>
    <p class="status model-progress" data-progress="${esc(row.id)}">${active?'下载中…':ready?'模型已下载；HQ3 / Vocal FT 可尝试实验性分离，尚未通过真机验证':'模型尚未下载'}</p></div>`;
  }).join('');$('modelList').innerHTML=html;
  $('modelCancel').disabled=!state.activeId;
  $('modelDisk').textContent='可用存储空间：'+fmt(state.freeBytes)+'。模型可按需单独下载；安装其他模型无需重复下载已有模型。';
 }
 function refresh(){try{Object.assign(state,JSON.parse(STORE.getStatus()));render();}catch(e){message('读取模型状态失败：'+e.message);}}
 window.__modelEvent=ev=>{
  if(!ev||typeof ev!=='object')return;
  if(Array.isArray(ev.models)){Object.assign(state,ev);render();return;}
  if(ev.id){
   if(ev.type==='progress'){state.activeId=ev.id;const node=[...document.querySelectorAll('[data-progress]')].find(x=>x.dataset.progress===ev.id);
    if(node){const percent=ev.total>0?Math.min(100,Math.floor(ev.bytes/ev.total*100))+'%':'下载中';node.textContent=percent+' · '+fmt(ev.bytes)+(ev.total>0?' / '+fmt(ev.total):'');}
    $('modelCancel').disabled=false;
   }else{message((rows.find(x=>x.id===ev.id)?.name||ev.id)+'：'+(ev.message||ev.type));}
  }
 };
 $('modelList').addEventListener('click',e=>{
  const b=e.target.closest('button[data-cmd]'),card=b?.closest('[data-model]');if(!STORE||!b||!card)return;
  const id=card.dataset.model;
  if(b.dataset.cmd==='download'){message('开始下载，请保持网络畅通…');STORE.download(id);state.activeId=id;render();}
  if(b.dataset.cmd==='import')STORE.importLocal(id);
  if(b.dataset.cmd==='select'){selected=id;localStorage.setItem('musicline_selected_mdx',id);window.NativeMdxEngine?.selectModel(id);message('已选择 '+rows.find(x=>x.id===id)?.name+'。目前 HQ3 / Vocal FT 可以尝试实验性 WAV 分离，其他模型等待参数适配。');render();}
  if(b.dataset.cmd==='delete'&&confirm('确定删除本地模型？删除后如需使用必须重新下载。'))STORE.remove(id);
 });
 $('modelRefresh').addEventListener('click',refresh);
 $('modelCancel').addEventListener('click',()=>{if(STORE){STORE.cancel();message('正在取消下载…');}});
 window.NativeMdxEngine?.selectModel(selected);
 refresh();
})();
