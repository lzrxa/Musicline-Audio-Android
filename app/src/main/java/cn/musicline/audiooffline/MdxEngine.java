package cn.musicline.audiooffline;

import ai.onnxruntime.*;
import org.jtransforms.fft.FloatFFT_1D;
import java.io.*;
import java.nio.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Experimental offline MDX Net processor for Inst HQ3 / Vocal FT.
 * No network calls. Model is loaded from app-private storage only.
 * WAV PCM16 mono/stereo input; 44.1 kHz processing; WAV output.
 * On-device inference quality and compatibility require real-device testing.
 */
final class MdxEngine {
 static final int FFT=6144,HOP=1024,BINS=3072,FRAMES=256;
 static final int CHUNK=HOP*FRAMES,OVERLAP=HOP*8,STEP=CHUNK-OVERLAP;
 static final int SAMPLE_RATE=44100;
 interface Progress {void emit(int percent,String message);}
 static final class Result {final File target,complement; Result(File t,File c){target=t;complement=c;}}
 static final class Audio {final float[][] data; final int sr; Audio(float[][] d,int r){data=d;sr=r;}}
 static int u16(byte[] a,int at){return (a[at]&255)|((a[at+1]&255)<<8);}
 static long u32(byte[] a,int at){return ((long)a[at]&255)|(((long)(a[at+1]&255))<<8)|(((long)(a[at+2]&255))<<16)|(((long)(a[at+3]&255))<<24);}
 static Audio readWav(InputStream source)throws Exception{
  try(InputStream in=new BufferedInputStream(source)){
   byte[] header=new byte[12]; readFully(in,header,0,12);
   if(!new String(header,0,4,"US-ASCII").equals("RIFF")||!new String(header,8,4,"US-ASCII").equals("WAVE"))throw new IOException("仅支持标准 RIFF WAV，请先使用音频工具转换为 WAV");
   int channels=0,sr=0,bits=0,format=0;byte[] raw=null;
   for(int n=0;n<128;n++){
    byte[] h=new byte[8];int first=in.read();if(first==-1)break;h[0]=(byte)first;readFully(in,h,1,7);
    long len=u32(h,4);if(len>150L*1024*1024)throw new IOException("WAV 文件过大，请先截取短音频");
    String id=new String(h,0,4,"US-ASCII");
    if(id.equals("fmt ")){if(len<16||len>4096)throw new IOException("无效的 WAV fmt");byte[] x=new byte[(int)len];readFully(in,x,0,x.length);format=u16(x,0);channels=u16(x,2);sr=(int)u32(x,4);bits=u16(x,14);}
    else if(id.equals("data")){if(format==0)throw new IOException("WAV 数据块出现在格式块之前，暂不支持");if(len<1||len>60L*1024*1024)throw new IOException("当前原型限制输入 WAV 60MB 以内");raw=new byte[(int)len];readFully(in,raw,0,raw.length);break;}
    else skipFully(in,len);
    if((len&1)!=0)skipFully(in,1);
   }
   if(raw==null||format!=1||bits!=16||(channels!=1&&channels!=2)||sr<8000||sr>96000)throw new IOException("仅支持 PCM16 WAV，单/双声道，8-96 kHz");
   if(raw.length%(2*channels)!=0)throw new IOException("WAV data 长度不符合声道采样格式，文件可能损坏");
   int samples=raw.length/(2*channels);if(samples<2048)throw new IOException("音频太短");
   // Protect mobile memory. 90 s processing cap for this experimental pipeline.
   if(samples/(double)sr>90)throw new IOException("本阶段最多处理 90 秒，请先在音频工具中截取");
   float[][] out=new float[2][samples];
   for(int i=0;i<samples;i++){
    for(int c=0;c<channels;c++){
     int pos=2*(i*channels+c);int v=(short)((raw[pos]&255)|((raw[pos+1]&255)<<8));out[c][i]=v/32768f;
    }
    if(channels==1)out[1][i]=out[0][i];
   }
   return new Audio(out,sr);
  }
 }
 static void readFully(InputStream in,byte[] b,int off,int len)throws IOException {while(len>0){int n=in.read(b,off,len);if(n<=0)throw new EOFException("文件提前结束");len-=n;off+=n;}}
 static void skipFully(InputStream in,long n)throws IOException{while(n>0){long s=in.skip(n);if(s<=0){if(in.read()<0)throw new EOFException();s=1;}n-=s;}}
 static float[][] resample(Audio input){int old=input.data[0].length;if(input.sr==SAMPLE_RATE)return input.data;
  int n=(int)Math.ceil(old*(double)SAMPLE_RATE/input.sr);float[][] out=new float[2][n];
  for(int c=0;c<2;c++)for(int i=0;i<n;i++){double pos=(double)i*input.sr/SAMPLE_RATE;int k=Math.min(old-1,(int)pos);int k2=Math.min(old-1,k+1);float mix=(float)(pos-k);out[c][i]=input.data[c][k]*(1-mix)+input.data[c][k2]*mix;}
  return out;
 }
 static float[] hann(){float[] w=new float[FFT];for(int i=0;i<FFT;i++)w[i]=(float)(.5-.5*Math.cos(2*Math.PI*i/FFT));return w;}
 static int reflect(int i,int n){if(n<=1)return 0;while(i<0||i>=n){if(i<0)i=-i;if(i>=n)i=2*n-2-i;}return i;}
 static FloatBuffer spectrum(float[][] audio,int base,FloatFFT_1D fft,float[] win){
  FloatBuffer spec=ByteBuffer.allocateDirect(4*BINS*FRAMES*4).order(ByteOrder.nativeOrder()).asFloatBuffer();
  float[] buffer=new float[2*FFT];int n=audio[0].length;
  for(int channel=0;channel<2;channel++)for(int t=0;t<FRAMES;t++){
   Arrays.fill(buffer,0);int anchor=base+t*HOP-FFT/2;
   for(int j=0;j<FFT;j++)buffer[2*j]=audio[channel][reflect(anchor+j,n)]*win[j];
   fft.complexForward(buffer);
   int realPlane=channel*2,imagPlane=channel*2+1;
   for(int b=0;b<BINS;b++){
    spec.put(((realPlane*BINS+b)*FRAMES+t),buffer[2*b]);
    spec.put(((imagPlane*BINS+b)*FRAMES+t),buffer[2*b+1]);
   }
  }
  spec.position(0);return spec;
 }
 static float[][] toWave(FloatBuffer predicted,FloatFFT_1D fft,float[] win){
  float[][] signal=new float[2][CHUNK];float[] norm=new float[CHUNK];
  float[] buf=new float[2*FFT];
  for(int c=0;c<2;c++)for(int t=0;t<FRAMES;t++){
   Arrays.fill(buf,0);int rp=c*2,ip=c*2+1;
   for(int b=0;b<BINS;b++){
    float re=predicted.get((rp*BINS+b)*FRAMES+t),im=predicted.get((ip*BINS+b)*FRAMES+t);
    if(!Float.isFinite(re)||!Float.isFinite(im))throw new IllegalArgumentException("模型输出包含无效频谱值");
    buf[2*b]=re;buf[2*b+1]=im;
    if(b>0){buf[2*(FFT-b)]=re;buf[2*(FFT-b)+1]=-im;}
   }
   fft.complexInverse(buf,true);
   int start=t*HOP-FFT/2;
   for(int j=0;j<FFT;j++){int at=start+j;if(at>=0&&at<CHUNK){signal[c][at]+=buf[2*j]*win[j];if(c==0)norm[at]+=win[j]*win[j];}}
  }
  for(int c=0;c<2;c++)for(int i=0;i<CHUNK;i++)signal[c][i]=norm[i]>1e-7f?signal[c][i]/norm[i]:0;
  return signal;
 }
 static Result separate(File model,InputStream wav,File outDir,AtomicBoolean cancel,Progress status)throws Exception{
  status.emit(1,"正在解码本地 WAV…");Audio in=readWav(wav);float[][] audio=resample(in);int length=audio[0].length;
  float[][] target=new float[2][length];float[] weight=new float[length];
  if(cancel.get())throw new InterruptedIOException("用户取消分离");
  float[] win=hann();FloatFFT_1D fft=new FloatFFT_1D(FFT);
  OrtEnvironment env=OrtEnvironment.getEnvironment();
  OrtSession.SessionOptions settings=new OrtSession.SessionOptions();settings.setIntraOpNumThreads(Math.max(1,Math.min(2,Runtime.getRuntime().availableProcessors()-1)));
  try(OrtSession session=env.createSession(model.getAbsolutePath(),settings)){
   if(session.getInputNames().size()!=1 || session.getOutputNames().size()!=1)
    throw new IOException("模型输入/输出数量不符合 MDX 频谱分离预期");
   String name=session.getInputNames().iterator().next();
   TensorInfo info=(TensorInfo)session.getInputInfo().get(name).getInfo();
   long[] shape=info.getShape();
   if(shape.length!=4||(shape[0]>0&&shape[0]!=1)||(shape[1]>0&&shape[1]!=4)||(shape[2]>0&&shape[2]!=BINS)||(shape[3]>0&&shape[3]!=FRAMES))
    throw new IOException("模型输入维度与当前 HQ3/VocFT 引擎不匹配："+Arrays.toString(shape));
   // Reject incompatible output graphs before spending CPU time processing audio.
   String outputName=session.getOutputNames().iterator().next();
   TensorInfo outInfo=(TensorInfo)session.getOutputInfo().get(outputName).getInfo();
   long[] outputShape=outInfo.getShape();
   if(outputShape.length!=4 || (outputShape[0]>0&&outputShape[0]!=1)
     || (outputShape[1]>0&&outputShape[1]!=4)
     || (outputShape[2]>0&&outputShape[2]!=BINS)
     || (outputShape[3]>0&&outputShape[3]!=FRAMES))
    throw new IOException("模型输出维度与 MDX 频谱引擎不匹配："+Arrays.toString(outputShape));
   int segments=(int)Math.ceil(Math.max(1,length-OVERLAP)/(double)STEP);
   for(int k=0;k<segments;k++){
    if(cancel.get())throw new InterruptedIOException("用户取消分离");int start=k*STEP;
    FloatBuffer spec=spectrum(audio,start,fft,win);
    FloatBuffer result;
    try(OnnxTensor tensor=OnnxTensor.createTensor(env,spec,new long[]{1,4,BINS,FRAMES});OrtSession.Result inference=session.run(Collections.singletonMap(name,tensor))){
     if(!(inference.get(0) instanceof OnnxTensor))throw new IOException("模型输出不是 Tensor");
     result=((OnnxTensor)inference.get(0)).getFloatBuffer();
     if(result.capacity()!=4*BINS*FRAMES)throw new IOException("模型输出形状不符合 MDX 频谱结构");
     if(cancel.get())throw new InterruptedIOException("用户取消分离");
     float[][] chunk=toWave(result,fft,win);
     int until=Math.min(CHUNK,length-start);
     for(int j=0;j<until;j++){
      float fade=1f;if(k>0&&j<OVERLAP)fade=Math.min(fade,(float)j/OVERLAP);
      if(k<segments-1&&j>=CHUNK-OVERLAP)fade=Math.min(fade,(float)(CHUNK-j)/OVERLAP);
      float w=Math.max(0,fade);int at=start+j;weight[at]+=w;
      for(int c=0;c<2;c++)target[c][at]+=chunk[c][j]*w;
     }
    }
    status.emit(5+(int)(k+1)*88/segments,"已完成第 "+(k+1)+" / "+segments+" 段频谱推理");
   }
  }finally{settings.close();}
  if(cancel.get())throw new InterruptedIOException("用户取消分离");
  for(int i=0;i<length;i++)for(int c=0;c<2;c++)target[c][i]=weight[i]>1e-6f?target[c][i]/weight[i]:0;
  float[][] rest=new float[2][length];for(int c=0;c<2;c++)for(int i=0;i<length;i++)rest[c][i]=audio[c][i]-target[c][i];
  if(!outDir.exists()&&!outDir.mkdirs())throw new IOException("无法创建输出目录");
  File a=new File(outDir,"target.wav"),b=new File(outDir,"complement.wav");
  File ap=new File(outDir,"target.wav.partial"),bp=new File(outDir,"complement.wav.partial");
  ap.delete();bp.delete();
  try {
   if(cancel.get())throw new InterruptedIOException("用户取消分离");
   writeWav(ap,target);
   if(cancel.get())throw new InterruptedIOException("用户取消分离");
   writeWav(bp,rest);
   if(cancel.get())throw new InterruptedIOException("用户取消分离");
   // Only publish the two named outputs after both are complete.
   if(a.exists()&&!a.delete())throw new IOException("无法替换旧目标音轨");
   if(b.exists()&&!b.delete())throw new IOException("无法替换旧剩余音轨");
   if(!ap.renameTo(a))throw new IOException("目标音轨保存失败");
   if(!bp.renameTo(b)){a.delete();throw new IOException("剩余音轨保存失败");}
   long expectedBytes=44L+4L*length;
   if(a.length()!=expectedBytes||b.length()!=expectedBytes)throw new IOException("双轨 WAV 输出长度异常，可能未写完");
   status.emit(100,"已完成双轨 WAV 输出");return new Result(a,b);
  } catch(Exception problem){a.delete();b.delete();throw problem;}
  finally{ap.delete();bp.delete();}
 }
 static void put16(OutputStream out,int v)throws IOException{out.write(v&255);out.write((v>>>8)&255);}
 static void put32(OutputStream out,int v)throws IOException{put16(out,v);put16(out,v>>>16);}
 static void writeWav(File f,float[][] samples)throws IOException{
  int n=samples[0].length;if(n>Integer.MAX_VALUE/4-44)throw new IOException("导出音频过大");int size=n*4;
  if(samples.length!=2||samples[1].length!=n)throw new IOException("输出声道长度不一致");
  for(int c=0;c<2;c++)for(int i=0;i<n;i++)if(!Float.isFinite(samples[c][i]))throw new IOException("输出音频包含无效浮点采样");
  try(OutputStream out=new BufferedOutputStream(new FileOutputStream(f))){
   out.write("RIFF".getBytes("US-ASCII"));put32(out,36+size);out.write("WAVEfmt ".getBytes("US-ASCII"));
   put32(out,16);put16(out,1);put16(out,2);put32(out,SAMPLE_RATE);put32(out,SAMPLE_RATE*4);put16(out,4);put16(out,16);
   out.write("data".getBytes("US-ASCII"));put32(out,size);
   for(int i=0;i<n;i++)for(int c=0;c<2;c++){float x=Math.max(-1f,Math.min(1f,samples[c][i]));put16(out,(short)Math.round(x*32767));}
  }
 }
}
