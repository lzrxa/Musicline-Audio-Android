#!/usr/bin/env python3
"""Validate a user-supplied MDX model on desktop. ONNX Runtime is optional.
Usage: python tests/probe_real_onnx.py /path/to/UVR-MDX-NET-Inst_HQ_3.onnx --run
Requires pip install numpy onnxruntime for graph I/O; use --run for CPU inference.
Does not upload audio or weights. No Android equivalence claimed.
"""
import argparse, hashlib, json, sys, time
from pathlib import Path
import numpy as np

parser=argparse.ArgumentParser(description='Offline MDX ONNX diagnostic probe')
parser.add_argument('model',type=Path)
parser.add_argument('--run',action='store_true',help='Run a single zero-input CPU inference (may be slow)')
parser.add_argument('--sha256',help='Expected SHA256 when you have a trusted published digest')
args=parser.parse_args()
f=args.model
if not f.is_file():sys.exit('FAIL: model file not found')
h=hashlib.sha256()
with f.open('rb') as fh:
    for c in iter(lambda:fh.read(1024*1024),b''):h.update(c)
digest=h.hexdigest()
print(json.dumps({'model':f.name,'bytes':f.stat().st_size,'sha256':digest},ensure_ascii=False,indent=2))
if args.sha256 and digest.lower()!=args.sha256.lower():sys.exit('FAIL: SHA256 mismatch')
try:import onnxruntime as ort
except ImportError:sys.exit('INCOMPLETE: install onnxruntime: python -m pip install onnxruntime')
s=ort.InferenceSession(str(f),providers=['CPUExecutionProvider'])
ins,outs=s.get_inputs(),s.get_outputs()
print('inputs:',[(a.name,a.shape,a.type) for a in ins]);print('outputs:',[(a.name,a.shape,a.type) for a in outs]);
expected=[1,4,3072,256]
def matches(shape):return len(shape)==4 and all((not isinstance(g,int) or g<=0 or g==e) for g,e in zip(shape,expected))
if len(ins)!=1 or len(outs)!=1 or not matches(ins[0].shape) or not matches(outs[0].shape):sys.exit('FAIL: model not compatible with the current HQ3/Vocal FT DSP contract')
if ins[0].type!='tensor(float)' or outs[0].type!='tensor(float)':sys.exit('FAIL: expected float32 tensors')
print('PASS: input/output shape/type preflight')
if args.run:
    x=np.zeros(expected,dtype=np.float32)
    started=time.monotonic();result=s.run([outs[0].name],{ins[0].name:x})[0];duration=time.monotonic()-started
    if result.shape!=tuple(expected) or not np.isfinite(result).all():sys.exit('FAIL: output shape/values invalid')
    print(f'PASS: single zero-input CPU inference; {duration:.2f}s, max abs={float(np.max(np.abs(result))):.6f}')
else:print('NOTE: no actual inference run; add --run to enable it')
