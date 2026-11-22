// V3.12.49 EQ 实时试听处理器（AudioWorklet）：直接运行导出所用的同一个 createProcessor，
// 因此试听包含静态 EQ、动态 EQ、响度补偿与软限幅，与导出结果一致。切换参数时新旧处理器做 40 ms 等功率交叉淡化。
const XF=Math.round(sampleRate*0.04);
const ident={process:ch=>ch};
class EQ148 extends AudioWorkletProcessor{
 constructor(){super();this.cur=ident;this.next=null;this.x=0;this.port.onmessage=e=>{const m=e.data||{};let p=ident;
  if(m.s){try{p=globalThis.SongEQ146.createProcessor(m.s,sampleRate,2);}catch(err){this.port.postMessage({error:String(err&&err.message||err)});return;}}
  if(m.instant){this.cur=p;this.next=null;return;}
  if(this.next){this.next=p;return;}this.next=p;this.x=0;};}
 process(inputs,outputs){
  const inp=inputs[0],out=outputs[0];if(!out||!out.length)return true;const n=out[0].length;
  if(!inp||!inp.length){for(const o of out)o.fill(0);return true;}
  const L=inp[0],R=inp[1]||inp[0];
  const a=this.cur.process([L.slice(),R.slice()]);
  if(this.next){const b=this.next.process([L.slice(),R.slice()]);
   for(let i=0;i<n;i++){const t=Math.min(1,(this.x+i)/XF),wa=Math.cos(t*Math.PI/2),wb=Math.sin(t*Math.PI/2);a[0][i]=a[0][i]*wa+b[0][i]*wb;a[1][i]=a[1][i]*wa+b[1][i]*wb;}
   this.x+=n;if(this.x>=XF){this.cur=this.next;this.next=null;}}
  out[0].set(a[0]);if(out[1])out[1].set(a[1]);for(let k=2;k<out.length;k++)out[k].set(a[0]);
  return true;}
}
registerProcessor('eq148',EQ148);
