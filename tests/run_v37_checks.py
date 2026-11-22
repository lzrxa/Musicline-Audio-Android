#!/usr/bin/env python3
"""V3.7 source checks; no Android build or real model execution is claimed."""
from pathlib import Path
import subprocess, sys, zipfile, json
root=Path(__file__).resolve().parents[1]
subprocess.run([sys.executable,str(root/'tests/run_v36_checks.py')],check=True)
main=(root/'app/src/main/java/cn/musicline/audiooffline/MainActivity.java').read_text()
js=(root/'app/src/main/assets/mdx-inference.js').read_text()
html=(root/'app/src/main/assets/index.html').read_text()
gradle=(root/'app/build.gradle').read_text()
assert "versionName '3.7.0-alpha'" in gradle
for name in ('probeSelectedModel','compatibleMdxShape','@JavascriptInterface public void probeModel()','inferencePool.submit','createSession(fileFor(id).getAbsolutePath(),options)'):
    assert name in main, name
assert 'id="mdxProbe"' in html and 'native.probeModel()' in js
assert 'realModelVerified",false' in main
assert '本地加载模型' in js
assert (root/'.github/workflows/android-debug-apk.yml').is_file()
print('PASS: V3.7 model graph probe, UI hook, task guard and version checks')
