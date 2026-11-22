package cn.musicline.audiooffline;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.webkit.*;
import android.widget.Toast;
import android.util.Base64;
import android.os.StatFs;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class MainActivity extends Activity {
 private WebView web;
 private ValueCallback<Uri[]> filePicker;
 private static final int PICK_FILE=18, SAVE_FILE=19, IMPORT_MODEL=20, PICK_MDX_AUDIO=21, SAVE_MDX_ZIP=22;
 private final ConcurrentHashMap<String,OutputStream> outputs=new ConcurrentHashMap<>();
 private final ExecutorService downloadPool=Executors.newSingleThreadExecutor();
 private String callbackId,saveToken,importModelId;
 private volatile String activeId=null;
 private volatile boolean cancelDownload=false;
 private final Object modelLock=new Object();
 private File modelDir;
 private final ExecutorService inferencePool=Executors.newSingleThreadExecutor();
 private final AtomicBoolean inferenceCancel=new AtomicBoolean(false);
 private final AtomicBoolean inferenceRunning=new AtomicBoolean(false);
 private final AtomicBoolean awaitingExport=new AtomicBoolean(false);
 private final AtomicBoolean exportCopying=new AtomicBoolean(false);
 private File pendingExportZip;
 private final Object exportLock=new Object();

 // Only these five immutable app-defined IDs can be requested via the JavaScript bridge.
 // Model files are stored in app-private filesDir, not the APK's assets or WebView cache.
 private static final String[] IDS={"UVR-MDX-NET-Inst_HQ_3","UVR-MDX-NET-Voc_FT","Kim_Vocal_2","UVR_MDXNET_KARA_2","UVR_MDXNET_Main"};
 private static final String[] LABELS={"MDX Inst HQ3","MDX Vocal FT","Kim Vocal 2","MDX Karaoke","MDX Main"};
 private static final String[] URLS={
  "https://huggingface.co/Anjok/model-repo/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx",
  "https://huggingface.co/Anjok/model-repo/resolve/main/UVR-MDX-NET-Voc_FT.onnx",
  "https://huggingface.co/Anjok/model-repo/resolve/main/Kim_Vocal_2.onnx",
  "https://huggingface.co/notabilia/uvr5-models/resolve/main/UVR_MDXNET_KARA_2.onnx",
  "https://huggingface.co/notabilia/uvr5-models/resolve/main/UVR_MDXNET_Main.onnx"
 };
 private static final String[] SHA256={
  "317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc",
  "","","",""
 };
 private static final long MIN_BYTES=20L*1024*1024,MAX_BYTES=130L*1024*1024;
 private static int indexOf(String id){for(int i=0;i<IDS.length;i++)if(IDS[i].equals(id))return i;return -1;}
 private File fileFor(String id){return new File(modelDir,id+".onnx");}
 private static String hash(File f)throws Exception{
  MessageDigest md=MessageDigest.getInstance("SHA-256");byte[] b=new byte[1024*1024];
  try(InputStream in=new FileInputStream(f)){int n;while((n=in.read(b))!=-1)md.update(b,0,n);}
  StringBuilder s=new StringBuilder();for(byte x:md.digest())s.append(String.format(Locale.ROOT,"%02x",x&255));return s.toString();
 }
 private boolean validFile(int i){
  File f=fileFor(IDS[i]);if(!f.isFile()||f.length()<MIN_BYTES||f.length()>MAX_BYTES)return false;
  try{String stored=getPreferences(0).getString("model_sha_"+IDS[i],"");
   if(stored.isEmpty())return false; // never trust a model not installed by the manager
   if(!SHA256[i].isEmpty()&&!SHA256[i].equalsIgnoreCase(stored))return false;
   return stored.equalsIgnoreCase(hash(f));}
  catch(Exception e){return false;}
 }
 private JSONObject status(){JSONObject x=new JSONObject();try{
  JSONArray models=new JSONArray();for(int i=0;i<IDS.length;i++){
   JSONObject m=new JSONObject();m.put("id",IDS[i]);m.put("name",LABELS[i]);
   m.put("downloaded",validFile(i));m.put("bytes",fileFor(IDS[i]).isFile()?fileFor(IDS[i]).length():0);
   m.put("shaLocked",!SHA256[i].isEmpty());models.put(m);
  }
  x.put("models",models);x.put("activeId",activeId==null?JSONObject.NULL:activeId);
  x.put("freeBytes",new StatFs(modelDir.getAbsolutePath()).getAvailableBytes());
  x.put("inferenceImplemented",true);
  x.put("inferenceVerified",false); // No real-model / physical-device verification yet
  x.put("inferenceReady",validFile(0)||validFile(1)); // experimental entrypoint only
 }catch(Exception ignored){}return x;}
 private JSONObject diagnostics(){
  JSONObject d=new JSONObject();
  try{
   d.put("appVersion","4.0.0-rc1");
   d.put("localUi","appassets.androidplatform.net");
   d.put("storageReady",modelDir!=null&&modelDir.isDirectory()&&modelDir.canWrite());
   d.put("diskFreeBytes",modelDir==null?0:new StatFs(modelDir.getAbsolutePath()).getAvailableBytes());
   d.put("taskRunning",inferenceRunning.get());
   d.put("awaitingExport",awaitingExport.get());
   d.put("exportCopying",exportCopying.get());
   d.put("modelCount",IDS.length);
   try{ai.onnxruntime.OrtEnvironment.getEnvironment();d.put("onnxRuntimeLoaded",true);}
   catch(Throwable t){d.put("onnxRuntimeLoaded",false);d.put("runtimeError",t.getClass().getSimpleName());}
   d.put("realModelVerified",false);
  }catch(Exception ignored){}
  return d;
 }
 private void event(JSONObject data){String payload=data.toString();runOnUiThread(()->{
  if(web!=null)web.evaluateJavascript("window.__modelEvent&&window.__modelEvent("+payload+")",null);
 });}
 private void report(String kind,String id,long bytes,long total,String message){JSONObject j=new JSONObject();try{
  j.put("type",kind);j.put("id",id);j.put("bytes",bytes);j.put("total",total);j.put("message",message);
 }catch(Exception ignored){}event(j);}
 private String trustedRedirect(String initial)throws Exception{
  URL url=new URL(initial);
  for(int j=0;j<8;j++){
   if(!"https".equalsIgnoreCase(url.getProtocol()))throw new IOException("仅允许 HTTPS 下载");
   String host=url.getHost().toLowerCase(Locale.ROOT);
   if(!(host.equals("huggingface.co")||host.endsWith(".huggingface.co")||host.endsWith(".hf.co")||host.equals("hf.co")||host.endsWith(".xethub.hf.co")||host.equals("cdn-lfs.hf.co")))throw new IOException("不受信任的下载域名："+host);
   HttpURLConnection c=(HttpURLConnection)url.openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(30000);
   c.setRequestProperty("User-Agent","MusiclineOfflineAudio/2.0");int status=c.getResponseCode();
   if(status>=300&&status<400){String next=c.getHeaderField("Location");c.disconnect();if(next==null)throw new IOException("下载跳转无地址");url=new URL(url,next);continue;}
   c.disconnect();return url.toString();
  }
  throw new IOException("模型下载跳转次数过多");
 }
 private void downloadModel(String id){int i=indexOf(id);if(i<0)return;
  synchronized(modelLock){if(activeId!=null){report("error",id,0,0,"已有模型正在下载");return;}activeId=id;cancelDownload=false;}
  downloadPool.submit(()->{
   File finalFile=fileFor(id),tmp=new File(modelDir,id+".partial");
   try{
    if(validFile(i)){report("done",id,finalFile.length(),finalFile.length(),"模型已在本地，无需再次下载");return;}
    StatFs sf=new StatFs(modelDir.getAbsolutePath());if(sf.getAvailableBytes()<MAX_BYTES+32L*1024*1024)throw new IOException("手机空间不足，请预留至少 170 MB");
    String resolved=trustedRedirect(URLS[i]);URL u=new URL(resolved);
    HttpURLConnection c=(HttpURLConnection)u.openConnection();
    c.setConnectTimeout(20000);c.setReadTimeout(35000);c.setInstanceFollowRedirects(false);
    c.setRequestProperty("User-Agent","MusiclineOfflineAudio/2.0");
    int code=c.getResponseCode();if(code!=200)throw new IOException("服务器返回 HTTP "+code);
    long len=c.getContentLengthLong();if(len>MAX_BYTES)throw new IOException("文件超过安全大小限制");
    tmp.delete();long bytes=0;long last=0;
    MessageDigest md=MessageDigest.getInstance("SHA-256");
    try(InputStream in=new BufferedInputStream(c.getInputStream());FileOutputStream out=new FileOutputStream(tmp)){
     byte[] buf=new byte[256*1024];int n;
     while((n=in.read(buf))!=-1){if(cancelDownload)throw new InterruptedIOException("下载已取消");
      bytes+=n;if(bytes>MAX_BYTES)throw new IOException("模型文件过大");
      md.update(buf,0,n);out.write(buf,0,n);
      long now=android.os.SystemClock.elapsedRealtime();if(now-last>350){report("progress",id,bytes,len,"下载中");last=now;}
     }
     out.getFD().sync();
    }finally{c.disconnect();}
    if(bytes<MIN_BYTES)throw new IOException("模型过小，可能下载了错误页面");
    if(len>0&&bytes!=len)throw new IOException("模型下载不完整");
    StringBuilder sb=new StringBuilder();for(byte b:md.digest())sb.append(String.format(Locale.ROOT,"%02x",b&255));String digest=sb.toString();
    if(!SHA256[i].isEmpty()&&!digest.equalsIgnoreCase(SHA256[i]))throw new IOException("SHA-256 校验失败，模型版本不一致");
    if(finalFile.exists()&&!finalFile.delete())throw new IOException("无法替换旧模型文件");
    if(!tmp.renameTo(finalFile))throw new IOException("无法保存下载模型");
    getPreferences(0).edit().putString("model_sha_"+id,digest).apply();
    report("done",id,bytes,bytes,"模型下载完成并已保存到手机本地");
   }catch(Exception e){tmp.delete();report("error",id,0,0,e.getMessage()==null?"模型下载失败":e.getMessage());}
   finally{synchronized(modelLock){activeId=null;}event(status());}
  });
 }
 private void importModel(String id,Uri uri){int i=indexOf(id);if(i<0)return;
  downloadPool.submit(()->{
   synchronized(modelLock){if(activeId!=null){report("error",id,0,0,"请等待正在进行的下载完成");return;}activeId=id;}
   File tmp=new File(modelDir,id+".partial");try{
    MessageDigest md=MessageDigest.getInstance("SHA-256");long bytes=0;
    try(InputStream in=getContentResolver().openInputStream(uri);FileOutputStream out=new FileOutputStream(tmp)){
     if(in==null)throw new IOException("无法读取选择的模型");byte[] buf=new byte[256*1024];int n;
     while((n=in.read(buf))!=-1){bytes+=n;if(bytes>MAX_BYTES)throw new IOException("模型过大");md.update(buf,0,n);out.write(buf,0,n);}out.getFD().sync();
    }
    if(bytes<MIN_BYTES)throw new IOException("文件不是有效的 MDX ONNX 模型（体积过小）");
    StringBuilder sb=new StringBuilder();for(byte b:md.digest())sb.append(String.format(Locale.ROOT,"%02x",b&255));String digest=sb.toString();
    if(!SHA256[i].isEmpty()&&!digest.equalsIgnoreCase(SHA256[i]))throw new IOException("模型哈希与内置校验值不匹配");
    File f=fileFor(id);if(f.exists()&&!f.delete())throw new IOException("无法替换旧文件");
    if(!tmp.renameTo(f))throw new IOException("无法保存模型");
    getPreferences(0).edit().putString("model_sha_"+id,digest).apply();report("done",id,bytes,bytes,"模型从本地文件导入成功");
   }catch(Exception e){tmp.delete();report("error",id,0,0,e.getMessage());}
   finally{synchronized(modelLock){activeId=null;}event(status());}
  });
 }
 @Override public void onCreate(Bundle saved){super.onCreate(saved);
  modelDir=new File(getFilesDir(),"mdx-models");if(!modelDir.exists())modelDir.mkdirs();
  web=new WebView(this);setContentView(web);
  WebView.setWebContentsDebuggingEnabled(false);
  WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);
  s.setMediaPlaybackRequiresUserGesture(true);s.setAllowFileAccess(false);
  s.setAllowContentAccess(true);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
  web.addJavascriptInterface(new FileBridge(),"AndroidFileBridge");
  web.addJavascriptInterface(new ModelBridge(),"NativeModelStore");
  web.addJavascriptInterface(new InferenceBridge(),"NativeMdxEngine");
  WebViewAssetLoader loader=new WebViewAssetLoader.Builder().addPathHandler("/",new WebViewAssetLoader.AssetsPathHandler(this)).build();
  web.setWebViewClient(new WebViewClientCompat(){
   @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){
    Uri u=r.getUrl();if(!"appassets.androidplatform.net".equals(u.getHost()))return null;
    String path=u.getPath();if(path!=null&&path.startsWith("/offline-models/")&&path.endsWith(".onnx")){
     String id=path.substring(16,path.length()-5);int i=indexOf(id);
     if(i<0)return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));
     try{if(!validFile(i))return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));
      WebResourceResponse x=new WebResourceResponse("application/octet-stream",null,new FileInputStream(fileFor(id)));
      x.setResponseHeaders(Collections.singletonMap("Cache-Control","no-store"));return x;
     }catch(Exception e){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}
    }
    return loader.shouldInterceptRequest(u);
   }
   @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return !"appassets.androidplatform.net".equals(r.getUrl().getHost());}
  });
  web.setWebChromeClient(new WebChromeClient(){@Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> cb,FileChooserParams p){
   if(filePicker!=null)filePicker.onReceiveValue(null);filePicker=cb;
   try{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.setType("*/*");i.addCategory(Intent.CATEGORY_OPENABLE);i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivityForResult(i,PICK_FILE);return true;}
   catch(Exception e){filePicker=null;return false;}
  }});
  web.loadUrl("https://appassets.androidplatform.net/index.html");
 }
 @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);
  if(request==PICK_MDX_AUDIO){
   if(result==RESULT_OK&&data!=null&&data.getData()!=null)runMdx(data.getData());
   else { inferenceRunning.set(false);mdxMessage("error",0,"未选择音频文件"); }
   return;
  }
  if(request==SAVE_MDX_ZIP){
   // Never copy potentially large audio ZIPs on Android's main thread.
   final Uri dest=result==RESULT_OK&&data!=null?data.getData():null;
   final File pending;
   synchronized(exportLock){pending=pendingExportZip;pendingExportZip=null;}
   if(dest==null||pending==null){
    if(pending!=null)pending.delete();
    mdxMessage("done",100,"已取消保存，临时结果已清理");
    awaitingExport.set(false);inferenceRunning.set(false);
    return;
   }
   exportCopying.set(true);
   mdxMessage("progress",100,"正在后台保存双轨 ZIP，请勿关闭 APP…");
   inferencePool.submit(()->{
    try{
     final long expected=pending.length();
     if(expected<100)throw new IOException("双轨 ZIP 文件不存在或长度异常");
     long bytes=0;
     try(InputStream in=new BufferedInputStream(new FileInputStream(pending));
         OutputStream raw=getContentResolver().openOutputStream(dest,"w")){
      if(raw==null)throw new IOException("目标文件无法写入");
      try(OutputStream out=new BufferedOutputStream(raw)){
       byte[] buffer=new byte[256*1024];int n;
       while((n=in.read(buffer))!=-1){
        if(n==0)continue;
        out.write(buffer,0,n);bytes+=n;
       }
       out.flush();
      }
     }
     if(bytes!=expected)throw new IOException("保存不完整："+bytes+" / "+expected+" 字节");
     mdxMessage("saved",100,"双轨 ZIP 已保存（"+(bytes/1048576.0)+" MB）");
    }catch(Exception error){
     // ACTION_CREATE_DOCUMENT may leave an empty/partial document after an I/O error.
     // Best effort: remove it rather than show a corrupt file as a successful export.
     try{getContentResolver().delete(dest,null,null);}catch(Exception ignored){}
     mdxMessage("error",0,"保存失败，已尝试清理不完整文件："+error.getMessage());
    }finally{
     pending.delete();
     exportCopying.set(false);awaitingExport.set(false);inferenceRunning.set(false);
    }
   });
   return;
  }
  if(request==PICK_FILE){if(filePicker!=null){Uri[] value=result==RESULT_OK&&data!=null&&data.getData()!=null?new Uri[]{data.getData()}:null;filePicker.onReceiveValue(value);filePicker=null;}return;}
  if(request==IMPORT_MODEL){String id=importModelId;importModelId=null;if(result==RESULT_OK&&data!=null&&data.getData()!=null&&id!=null)importModel(id,data.getData());return;}
  if(request==SAVE_FILE){String cb=callbackId,tok=saveToken;callbackId=null;saveToken=null;if(cb==null)return;
   if(result==RESULT_OK&&data!=null&&data.getData()!=null){try{outputs.put(tok,getContentResolver().openOutputStream(data.getData()));answer(cb,tok,null);}catch(Exception e){answer(cb,null,e.getMessage());}}
   else answer(cb,null,"用户取消保存");}
 }
 private void answer(String cb,String token,String err){runOnUiThread(()->web.evaluateJavascript("window.__onSaveReady("+JSONObject.quote(cb)+","+(token==null?"null":JSONObject.quote(token))+","+(err==null?"null":JSONObject.quote(err))+")",null));}
 public class ModelBridge {
  @JavascriptInterface public String getStatus(){return status().toString();}
  @JavascriptInterface public void download(String id){if(indexOf(id)>=0)downloadModel(id);}
  @JavascriptInterface public void cancel(){cancelDownload=true;}
  @JavascriptInterface public void remove(String id){int i=indexOf(id);if(i<0)return;
   downloadPool.submit(()->{if(id.equals(activeId)){report("error",id,0,0,"请先取消正在下载的模型");return;}
    File f=fileFor(id);boolean deleted=!f.exists()||f.delete();
    if(deleted)getPreferences(0).edit().remove("model_sha_"+id).apply();
    report(deleted?"removed":"error",id,0,0,deleted?"已删除本地模型":"模型删除失败");event(status());
   });
  }
  @JavascriptInterface public void importLocal(String id){if(indexOf(id)<0)return;
   runOnUiThread(()->{importModelId=id;try{Intent in=new Intent(Intent.ACTION_OPEN_DOCUMENT);in.setType("*/*");in.addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(in,IMPORT_MODEL);}catch(Exception e){report("error",id,0,0,e.getMessage());}});
  }
 }
 private void mdxMessage(String kind,int percent,String message){JSONObject obj=new JSONObject();try{
  obj.put("type",kind);obj.put("percent",percent);obj.put("message",message);
 }catch(Exception ignored){}String payload=obj.toString();runOnUiThread(()->{
  if(web!=null)web.evaluateJavascript("window.__mdxEvent&&window.__mdxEvent("+payload+")",null);
 });}
 // Actual local-model graph preflight. This runs on the same single-threaded inference pool
 // as separation, and does not upload or process audio. A compatible graph is not proof
 // that resulting stems are acoustically correct.
 private void probeSelectedModel(){
  if(!inferenceRunning.compareAndSet(false,true)){
   mdxMessage("error",0,"请先完成当前分离或导出任务，再检查模型");return;
  }
  inferencePool.submit(()->{
   try{
    String id=getPreferences(0).getString("mdx_selection","UVR-MDX-NET-Inst_HQ_3");
    int idx=indexOf(id);
    if(idx<0||!validFile(idx))throw new IOException("所选模型未下载、文件损坏或校验未通过");
    if(idx>1)throw new IOException("当前仅为 HQ3 与 Vocal FT 实现频谱推理；其余模型需分别适配");
    ai.onnxruntime.OrtEnvironment env=ai.onnxruntime.OrtEnvironment.getEnvironment();
    try(ai.onnxruntime.OrtSession.SessionOptions options=new ai.onnxruntime.OrtSession.SessionOptions();
        ai.onnxruntime.OrtSession session=env.createSession(fileFor(id).getAbsolutePath(),options)){
     if(session.getInputNames().size()!=1||session.getOutputNames().size()!=1)
      throw new IOException("模型输入或输出数量不匹配（需单输入、单输出）");
     String input=session.getInputNames().iterator().next();
     String output=session.getOutputNames().iterator().next();
     ai.onnxruntime.NodeInfo i=session.getInputInfo().get(input);
     ai.onnxruntime.NodeInfo o=session.getOutputInfo().get(output);
     if(!(i.getInfo() instanceof ai.onnxruntime.TensorInfo)||!(o.getInfo() instanceof ai.onnxruntime.TensorInfo))
      throw new IOException("模型输入或输出不是张量");
     long[] si=((ai.onnxruntime.TensorInfo)i.getInfo()).getShape();
     long[] so=((ai.onnxruntime.TensorInfo)o.getInfo()).getShape();
     if(!compatibleMdxShape(si)||!compatibleMdxShape(so))
      throw new IOException("输入 "+Arrays.toString(si)+"；输出 "+Arrays.toString(so)+"。与 [1,4,3072,256] 引擎不匹配");
     mdxMessage("probe",100,"真实本地 ONNX 图加载成功："+LABELS[idx]+"\n输入 "+Arrays.toString(si)+"\n输出 "+Arrays.toString(so)+"\n仍需运行 10 秒音频并人工检查分离音质");
    }
   }catch(Throwable t){mdxMessage("error",0,"模型预检失败："+(t.getMessage()==null?t.getClass().getSimpleName():t.getMessage()));}
   finally{inferenceRunning.set(false);}
  });
 }
 // A real, local ONNX execution smoke test using a generated 10-second stereo WAV.
 // This tests model loading -> inference -> WAV export. It is NOT a musical quality test.
 private void runSyntheticMdxSelfTest(){
  if(!inferenceRunning.compareAndSet(false,true)){
   mdxMessage("error",0,"已有模型检查、分离或保存任务正在进行");return;
  }
  inferenceCancel.set(false);
  inferencePool.submit(()->{
   File folder=new File(getCacheDir(),"mdx-selftest");
   File source=new File(folder,"synthetic-input.wav");
   try{
    String id=getPreferences(0).getString("mdx_selection","UVR-MDX-NET-Inst_HQ_3");
    int idx=indexOf(id);
    if(idx<0||idx>1)throw new IOException("自检目前仅支持 HQ3 / Vocal FT 两款已适配模型");
    if(!validFile(idx))throw new IOException("请先下载并通过校验所选模型");
    if(!folder.exists()&&!folder.mkdirs())throw new IOException("无法建立临时测试目录");
    final int samples=44100*10;
    float[][] test=new float[2][samples];
    for(int i=0;i<samples;i++){
     double t=i/44100.0;
     test[0][i]=(float)(.18*Math.sin(2*Math.PI*220*t)+.10*Math.sin(2*Math.PI*440*t));
     test[1][i]=(float)(.18*Math.sin(2*Math.PI*330*t)+.10*Math.sin(2*Math.PI*550*t));
    }
    MdxEngine.writeWav(source,test);
    test=null;
    if(inferenceCancel.get())throw new InterruptedIOException("已取消本地推理自检");
    mdxMessage("progress",2,"合成测试音频已生成；正在执行真实模型推理（不访问网络）…");
    MdxEngine.Result result;
    try(InputStream in=new BufferedInputStream(new FileInputStream(source))){
     result=MdxEngine.separate(fileFor(id),in,folder,inferenceCancel,
      (percent,message)->mdxMessage("progress",percent,message));
    }
    if(inferenceCancel.get())throw new InterruptedIOException("已取消本地推理自检");
    long expected=44L+44100L*10*4;
    if(!result.target.isFile()||!result.complement.isFile()
       ||result.target.length()!=expected||result.complement.length()!=expected)
      throw new IOException("推理完成，但双轨 WAV 大小不正确");
    // Decode both results so that headers and PCM sample counts are verified, not just file length.
    try(InputStream a=new FileInputStream(result.target);InputStream b=new FileInputStream(result.complement)){
     MdxEngine.Audio left=MdxEngine.readWav(a),right=MdxEngine.readWav(b);
     if(left.sr!=44100||right.sr!=44100||left.data[0].length!=samples||right.data[0].length!=samples)
      throw new IOException("自检输出 WAV 的采样率或时长不正确");
    }
    mdxMessage("selftest",100,"本地 ONNX 10 秒合成音频推理与双轨 WAV 读写通过。注意：未验证真实歌曲分离音质。");
   }catch(OutOfMemoryError error){mdxMessage("error",0,"自检内存不足，请关闭其他应用后再试");}
    catch(Throwable error){mdxMessage("error",0,"本地推理自检失败："+(error.getMessage()==null?error.getClass().getSimpleName():error.getMessage()));}
   finally{
    for(String name:new String[]{"synthetic-input.wav","target.wav","complement.wav","target.wav.partial","complement.wav.partial"})
     new File(folder,name).delete();
    inferenceRunning.set(false);
   }
  });
 }
 private static boolean compatibleMdxShape(long[] shape){
  int[] expected={1,4,3072,256};
  if(shape==null||shape.length!=expected.length)return false;
  for(int j=0;j<4;j++)if(shape[j]>0&&shape[j]!=expected[j])return false;
  return true;
 }
 private void runMdx(Uri input){
  inferencePool.submit(()->{
   synchronized(exportLock){ if(pendingExportZip!=null){pendingExportZip.delete();pendingExportZip=null;} }
   // The cancellation flag is initialized by chooseWav() BEFORE the file picker.
   // Never clear it on this background thread: users may cancel while queued.
   File failedDirAtStart=new File(getCacheDir(),"mdx-result");
   new File(failedDirAtStart,"Musicline_MDX_双轨离线分离.zip").delete();
   new File(failedDirAtStart,"Musicline_MDX_双轨离线分离.zip.partial").delete();
   String id=getPreferences(0).getString("mdx_selection","UVR-MDX-NET-Inst_HQ_3");
   int idx=indexOf(id);
   try{
    if(idx<0||!(idx==0||idx==1))throw new IOException("当前仅对 HQ3 与 Vocal FT 提供实验性分离，请改选这两个模型");
    if(!validFile(idx))throw new IOException("该模型尚未下载或完整性验证失败");
    File folder=new File(getCacheDir(),"mdx-result");if(!folder.exists()&&!folder.mkdirs())throw new IOException("无法创建临时目录");
    try(InputStream audio=getContentResolver().openInputStream(input)){
     if(audio==null)throw new IOException("无法读取输入文件");
     MdxEngine.Result result=MdxEngine.separate(fileFor(id),audio,folder,inferenceCancel,(percent,text)->mdxMessage("progress",percent,text));
     if(inferenceCancel.get())throw new InterruptedIOException("已取消");
     File zip=new File(folder,"Musicline_MDX_双轨离线分离.zip");
     File zipPartial=new File(folder,"Musicline_MDX_双轨离线分离.zip.partial");
     if(zipPartial.exists())zipPartial.delete();
     String main=idx==0?"伴奏_HQ3.wav":"人声_VocalFT.wav";
     String rest=idx==0?"剩余人声_HQ3.wav":"剩余伴奏_VocalFT.wav";
     try(ZipOutputStream stream=new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(zipPartial)))){
      zipFile(stream,result.target,main);zipFile(stream,result.complement,rest);
     }
     result.target.delete();result.complement.delete();
     if(inferenceCancel.get())throw new InterruptedIOException("用户取消分离，结果未保存");
     if(!zipPartial.isFile()||zipPartial.length()<100)throw new IOException("压缩结果没有正确生成");
     // Reading every entry verifies the ZIP CRC and guards against truncated output.
     try(java.util.zip.ZipFile archive=new java.util.zip.ZipFile(zipPartial)){
      if(archive.size()!=2)throw new IOException("导出的 ZIP 音轨数量异常");
      java.util.Enumeration<? extends ZipEntry> entries=archive.entries();
      int count=0; byte[] buffer=new byte[256*1024];
      while(entries.hasMoreElements()){
       ZipEntry entry=entries.nextElement();count++;
       if(entry.isDirectory()||entry.getSize()<44||!entry.getName().endsWith(".wav"))throw new IOException("导出的 ZIP 包含不完整音轨");
       long read=0;java.util.zip.CRC32 crc=new java.util.zip.CRC32();
       try(InputStream check=archive.getInputStream(entry)){
        int n;while((n=check.read(buffer))!=-1){read+=n;crc.update(buffer,0,n);if(read>100L*1024*1024)throw new IOException("导出音轨异常过大");}
       }
       if(read!=entry.getSize()||crc.getValue()!=entry.getCrc())throw new IOException("ZIP 音轨大小或 CRC 校验失败");
      }
      if(count!=2)throw new IOException("ZIP 音轨数目异常");
     }
     if(inferenceCancel.get())throw new InterruptedIOException("用户取消分离，结果未保存");
     if(zip.exists()&&!zip.delete())throw new IOException("无法替换旧 ZIP 文件");
     if(!zipPartial.renameTo(zip))throw new IOException("最终 ZIP 保存失败");
     synchronized(exportLock){pendingExportZip=zip;}
     awaitingExport.set(true);
     mdxMessage("done",100,"双轨分离已完成，选择位置保存 ZIP");
     runOnUiThread(()->{
      try{Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT);save.setType("application/zip");
       save.addCategory(Intent.CATEGORY_OPENABLE);save.putExtra(Intent.EXTRA_TITLE,"Musicline_MDX_双轨离线分离.zip");startActivityForResult(save,SAVE_MDX_ZIP);
      }catch(Exception e){
       synchronized(exportLock){if(pendingExportZip!=null){pendingExportZip.delete();pendingExportZip=null;}}
       awaitingExport.set(false);inferenceRunning.set(false);
       mdxMessage("error",100,"保存对话框无法打开："+e.getMessage());
      }
     });
    }
   }catch(OutOfMemoryError e){
    File failedDir=new File(getCacheDir(),"mdx-result");
    for(String name:new String[]{"target.wav","complement.wav","target.wav.partial","complement.wav.partial","Musicline_MDX_双轨离线分离.zip","Musicline_MDX_双轨离线分离.zip.partial"})new File(failedDir,name).delete();
    mdxMessage("error",0,"运行内存不足，请处理 30 秒以内的短音频并关闭其他应用");
   }
   catch(Exception e){
    File failedDir=new File(getCacheDir(),"mdx-result");
    new File(failedDir,"target.wav.partial").delete();new File(failedDir,"complement.wav.partial").delete();
    new File(failedDir,"Musicline_MDX_双轨离线分离.zip.partial").delete();
    new File(failedDir,"Musicline_MDX_双轨离线分离.zip").delete();
    mdxMessage("error",0,e.getMessage()==null?"离线分离失败":e.getMessage());
   }
   finally{if(!awaitingExport.get())inferenceRunning.set(false);}
  });
 }
 private static void zipFile(ZipOutputStream out,File file,String name)throws IOException{
  out.putNextEntry(new ZipEntry(name));try(InputStream in=new BufferedInputStream(new FileInputStream(file))){byte[] buf=new byte[256*1024];int n;while((n=in.read(buf))>0)out.write(buf,0,n);}out.closeEntry();
 }
 public class InferenceBridge{
  @JavascriptInterface public String diagnostics(){return MainActivity.this.diagnostics().toString();}
  @JavascriptInterface public void selectModel(String id){int i=indexOf(id);if(i<0)return;
   getPreferences(0).edit().putString("mdx_selection",id).apply();}
  @JavascriptInterface public void probeModel(){runOnUiThread(()->probeSelectedModel());}
  @JavascriptInterface public void selfTest(){runOnUiThread(()->runSyntheticMdxSelfTest());}
  @JavascriptInterface public String selected(){return getPreferences(0).getString("mdx_selection","UVR-MDX-NET-Inst_HQ_3");}
  @JavascriptInterface public void chooseWav(){
   runOnUiThread(()->{
    if(!inferenceRunning.compareAndSet(false,true)){mdxMessage("error",0,"已有分离任务正在进行");return;}
    inferenceCancel.set(false);
    try{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.setType("audio/wav");
     intent.addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(intent,PICK_MDX_AUDIO);
    }catch(Exception e){inferenceRunning.set(false);mdxMessage("error",0,"文件选择失败："+e.getMessage());}
   });
  }
  @JavascriptInterface public void cancel(){
   if(awaitingExport.get()){mdxMessage("progress",100,exportCopying.get()?"正在后台保存文件，请等待保存完成":"分离已完成，请在系统保存窗口选择位置或取消保存");return;}
   inferenceCancel.set(true);
  }
 }
 public class FileBridge {
  @JavascriptInterface public void requestSave(String callback,String filename,String mime){runOnUiThread(()->{callbackId=callback;saveToken=UUID.randomUUID().toString();try{Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType(mime.isEmpty()?"application/octet-stream":mime);i.putExtra(Intent.EXTRA_TITLE,filename);startActivityForResult(i,SAVE_FILE);}catch(Exception e){answer(callback,null,e.getMessage());}});}
  @JavascriptInterface public void writeChunk(String token,String base64){try{OutputStream o=outputs.get(token);if(o==null)throw new Exception("保存任务不存在");o.write(Base64.decode(base64,Base64.DEFAULT));}catch(Exception e){runOnUiThread(()->Toast.makeText(MainActivity.this,"文件写入失败："+e.getMessage(),Toast.LENGTH_LONG).show());}}
  @JavascriptInterface public void finishSave(String token){try{OutputStream o=outputs.remove(token);if(o!=null)o.close();}catch(Exception ignored){}}
  @JavascriptInterface public void abortSave(String token){finishSave(token);}
 }
 @Override public void onBackPressed(){if(web!=null&&web.canGoBack())web.goBack();else super.onBackPressed();}
 @Override public void onDestroy(){synchronized(exportLock){if(pendingExportZip!=null){pendingExportZip.delete();pendingExportZip=null;}}cancelDownload=true;downloadPool.shutdownNow();inferenceCancel.set(true);inferencePool.shutdownNow();for(OutputStream o:outputs.values())try{o.close();}catch(Exception ignored){}outputs.clear();if(web!=null){web.destroy();web=null;}super.onDestroy();}
}
