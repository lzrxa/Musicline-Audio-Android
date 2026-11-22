#!/usr/bin/env python3
"""Model-free numerical reference check for Java MdxEngine STFT/iSTFT.
Requires numpy and scipy. Does NOT prove the ONNX model or Java DSP is correct.
"""
import numpy as np
from scipy.fft import fft, ifft

FFT,HOP,BINS,FRAMES=6144,1024,3072,256
CHUNK=HOP*FRAMES
OVERLAP=HOP*8
STEP=CHUNK-OVERLAP
WIN=np.hanning(FFT+1)[:-1].astype(np.float32)

def reflect_indices(idx,n):
    period=2*n-2
    z=np.mod(idx,period)
    return np.where(z>=n,period-z,z)

def roundtrip(audio,base):
    n=audio.shape[1]
    out=np.zeros((2,CHUNK),np.float64)
    norm=np.zeros(CHUNK,np.float64)
    for t in range(FRAMES):
        st=base+t*HOP-FFT//2
        ii=reflect_indices(st+np.arange(FFT),n)
        transformed=fft(audio[:,ii]*WIN[None,:],axis=1)
        # Model input's last positive frequency and Nyquist frequencies are omitted.
        spec=transformed[:,:BINS]
        full=np.zeros((2,FFT),np.complex64)
        full[:,:BINS]=spec
        full[:,FFT-BINS+1:]=np.conj(spec[:,1:][:,::-1])
        recovered=ifft(full,axis=1).real
        dst=np.arange(st-base,st-base+FFT)
        mask=(dst>=0)&(dst<CHUNK)
        out[:,dst[mask]]+=recovered[:,mask]*WIN[mask]
        norm[dst[mask]]+=WIN[mask]**2
    return (out/np.maximum(norm,1e-7)).astype(np.float32)

def main():
    rng=np.random.default_rng(27)
    sr=44100
    t=np.arange(sr*9,dtype=np.float64)/sr
    # Band-limited test signals: typical voiced harmonics without Nyquist bins
    audio=np.stack([.28*np.sin(2*np.pi*220*t)+.15*np.sin(2*np.pi*1780*t),
                    .25*np.sin(2*np.pi*440*t)+.08*np.sin(2*np.pi*1420*t)]).astype(np.float32)
    audio+=rng.normal(scale=1e-4,size=audio.shape).astype(np.float32)
    length=audio.shape[1]
    output=np.zeros_like(audio)
    weight=np.zeros(length,np.float32)
    segs=int(np.ceil(max(1,length-OVERLAP)/STEP))
    for k in range(segs):
        start=k*STEP
        chunk=roundtrip(audio,start)
        end=min(CHUNK,length-start)
        j=np.arange(end,dtype=np.float32)
        fade=np.ones(end,np.float32)
        if k>0:fade[:OVERLAP]=np.minimum(fade[:OVERLAP],j[:OVERLAP]/OVERLAP)
        if k<segs-1:
            edge=j>=CHUNK-OVERLAP
            fade[edge]=np.minimum(fade[edge],(CHUNK-j[edge])/OVERLAP)
        output[:,start:start+end]+=chunk[:,:end]*fade
        weight[start:start+end]+=fade
    output/=np.maximum(weight,1e-6)
    error=np.sqrt(np.mean((output-audio)**2))
    p=np.max(np.abs(output-audio))
    print(f'MDX reference FFT roundtrip: segments={segs}, RMSE={error:.8f}, max error={p:.7f}')
    # Some drift is inherent to discarding top FFT bins; this guards gross shape/window bugs.
    assert np.isfinite(output).all()
    assert error<0.003, f'Roundtrip error too high: {error}'
    assert len(weight)==len(t) and np.all(weight>0)
    print('PASS model-free reference FFT overlap-add')

if __name__=='__main__': main()
