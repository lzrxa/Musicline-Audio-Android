#!/usr/bin/env python3
"""Check WAV stems exported from Android. Does NOT establish separation quality."""
import argparse, io, sys, wave, zipfile
import numpy as np

def parse_wav(data):
    with wave.open(io.BytesIO(data),'rb') as w:
        assert w.getnchannels()==2, 'Expected stereo WAV'
        assert w.getframerate()==44100, 'Expected 44.1 kHz'
        assert w.getsampwidth()==2, 'Expected signed 16-bit PCM'
        frames=w.getnframes()
        arr=np.frombuffer(w.readframes(frames),dtype='<i2').astype(np.float64)/32768
        return frames,arr.reshape(-1,2)

def check_zip(path):
    with zipfile.ZipFile(path) as z:
        bad=z.testzip()
        assert bad is None, f'Corrupt ZIP member: {bad}'
        names=[n for n in z.namelist() if n.lower().endswith('.wav')]
        assert len(names)==2, f'Expected two WAV stems, found {names}'
        x=parse_wav(z.read(names[0])); y=parse_wav(z.read(names[1]))
        assert x[0]==y[0], 'Stem durations differ'
        assert np.all(np.isfinite(x[1])) and np.all(np.isfinite(y[1])), 'Invalid samples'
        assert x[0]>2048, 'Output too short'
        print(f'PASS: {path}: 2 PCM16 stereo WAVs, 44100 Hz, {x[0]/44100:.2f} s')
        print('WAV peak levels:', round(np.abs(x[1]).max(),4),round(np.abs(y[1]).max(),4))
        print('NOTE: This verifies packaging, not HQ3 model accuracy or audio quality.')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('exported_zip');args=p.parse_args()
    check_zip(args.exported_zip)
