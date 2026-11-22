#!/usr/bin/env python3
"""Static regression checks for the V3.8 ONNX device smoke-test entrypoint."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parents[1]
subprocess.run([sys.executable,str(root/'tests/run_v35_checks.py')],check=True)
main=(root/'app/src/main/java/cn/musicline/audiooffline/MainActivity.java').read_text()
js=(root/'app/src/main/assets/mdx-inference.js').read_text()
html=(root/'app/src/main/assets/index.html').read_text()
gradle=(root/'app/build.gradle').read_text()
assert "versionName '3.8.0-alpha'" in gradle
for symbol in ('runSyntheticMdxSelfTest','@JavascriptInterface public void selfTest()',
               'MdxEngine.separate(fileFor(id)', 'MdxEngine.writeWav(source,test)',
               'MdxEngine.readWav(a)', 'inferenceRunning.compareAndSet(false,true)',
               'inferenceRunning.set(false)'):
    assert symbol in main,symbol
assert 'id="mdxSelfTest"' in html
assert 'native.selfTest()' in js
assert "event.type==='selftest'" in js
assert 'realModelVerified",false' in main
print('PASS: V3.8 on-device real-model inference smoke-test and lifecycle checks')
