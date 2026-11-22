#!/usr/bin/env python3
"""Offline source preflight and binary APK ZIP verification; does not test real ONNX models."""
import argparse, hashlib, re, zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser()
p.add_argument('--source-only',action='store_true')
p.add_argument('--apk',type=Path)
a=p.parse_args()
assets=root/'app/src/main/assets'
html=(assets/'index.html').read_text(encoding='utf-8')
assert (assets/'offline.js').is_file()
assert (assets/'mdx-inference.js').is_file()
assert (assets/'model-manager.js').is_file()
assert (root/'app/src/main/java/cn/musicline/audiooffline/MdxEngine.java').is_file()
for ref in re.findall(r'(?:src|href)="(/[^"?#]+)',html):
    assert (assets/ref.lstrip('/')).is_file(), f'Missing offline page asset: {ref}'
for dep in ['AndroidFileBridge','NativeModelStore','NativeMdxEngine']:
    assert dep in (root/'app/src/main/java/cn/musicline/audiooffline/MainActivity.java').read_text(), f'Missing bridge {dep}'
gradle=(root/'app/build.gradle').read_text()
assert "versionName '4.0.0-rc1'" in gradle
assert 'com.microsoft.onnxruntime:onnxruntime-android' in gradle
print('PASS: source-level offline assets, bridges and declared dependencies')
if a.source_only: raise SystemExit(0)
if a.apk is None: raise SystemExit('Provide --apk path for binary check')
apk=a.apk
assert apk.is_file() and apk.stat().st_size > 100000, 'Actual APK not produced'
with zipfile.ZipFile(apk) as z:
    assert z.testzip() is None, 'Corrupted APK'
    names=set(z.namelist())
    required={'AndroidManifest.xml','classes.dex','assets/index.html','assets/offline.js','assets/mdx-inference.js','assets/model-manager.js'}
    assert required <= names, f'Missing APK entries: {required-names}'
    assert any(x.startswith('lib/arm64-v8a/') and x.endswith('.so') for x in names), 'No arm64 native ONNX libraries'
    assert any(x.startswith('lib/') and 'onnxruntime' in x for x in names), 'ONNX Runtime native library absent'
digest=hashlib.sha256(apk.read_bytes()).hexdigest()
sidecar=apk.with_suffix(apk.suffix+'.sha256')
sidecar.write_text(digest+'  '+apk.name+'\n',encoding='utf-8')
print('PASS: real APK verified, SHA-256:',digest)
