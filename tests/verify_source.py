#!/usr/bin/env python3
"""Non-executing source consistency smoke checks. Not a model inference test."""
from pathlib import Path
import re, json
root=Path(__file__).resolve().parents[1]
m=(root/'app/src/main/java/cn/musicline/audiooffline/MainActivity.java').read_text()
e=(root/'app/src/main/java/cn/musicline/audiooffline/MdxEngine.java').read_text()
assert 'compareAndSet(false,true)' in m
assert 'inferenceRunning.set(false)' in m
assert 'readFully(in,h,1,7)' in e
assert 'Float.isFinite' in e
assert 'session.getOutputNames().size()!=1' in e
assert 'target.wav.partial' in e
assert 'expectedBytes=44L+4L*length' in e
assert 'Float.isFinite(samples[c][i])' in e
assert 'Musicline_MDX_双轨离线分离.zip.partial' in m
assert '剩余音轨保存失败' in e
assert 'STFT' in (root/'README_安卓打包说明.md').read_text()
assert len(json.loads((root/'MODEL_REQUIREMENTS.json').read_text())['models'])==5
print('PASS: source consistency and 5-model inventory')
