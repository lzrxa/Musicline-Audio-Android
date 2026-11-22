#!/usr/bin/env python3
"""Offline build gate. No real ONNX weights, APK compilation or phone needed."""
import re, ast, json, subprocess, sys, zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
main=(root/'app/src/main/java/cn/musicline/audiooffline/MainActivity.java').read_text(encoding='utf-8')
engine=(root/'app/src/main/java/cn/musicline/audiooffline/MdxEngine.java').read_text(encoding='utf-8')
assets=root/'app/src/main/assets'
page=(assets/'index.html').read_text(encoding='utf-8')
# WebViewAssetLoader.AssetsPathHandler at '/' reads from APK assets root.
assert 'addPathHandler("/",new WebViewAssetLoader.AssetsPathHandler(this))' in main
assert 'web.loadUrl("https://appassets.androidplatform.net/index.html")' in main
assert not (assets/'www').exists(), 'Web resources incorrectly nested in /assets/www'
for path in re.findall(r'<(?:link|script)[^>]+(?:href|src)="(/[^"]+)"',page):
 assert (assets/path.lstrip('/').split('?')[0]).is_file(),f'Missing bundled resource: {path}'
for pth in ('offline.js','model-manager.js','mdx-inference.js'):
 assert (assets/pth).is_file(),pth

# One file per output stem: writing the same name twice raises ZipException.
zip_block=re.search(r'try\(ZipOutputStream stream=.*?\)\)\{(.*?)\n     \}',main,re.S)
assert zip_block, 'Missing ZIP creation block'
assert len(re.findall(r'zipFile\(stream,result\.target,main\);',zip_block.group(1)))==1, 'Duplicate target entry'
assert len(re.findall(r'zipFile\(stream,result\.complement,rest\);',zip_block.group(1)))==1, 'Duplicate complement entry'
# Race guard: clear cancel before starting picker and never on worker thread.
choose=main[main.index('@JavascriptInterface public void chooseWav()'):]
assert choose.index('inferenceCancel.set(false);') < choose.index('startActivityForResult(intent,PICK_MDX_AUDIO)')
run=main[main.index('private void runMdx('):main.index('private static void zipFile(')]
assert 'inferenceCancel.set(false)' not in run
assert 'if(inferenceCancel.get())throw new InterruptedIOException' in run
assert 'catch(OutOfMemoryError e)' in run
assert 'session.getOutputNames().size()!=1' in engine
assert len(json.loads((root/'MODEL_REQUIREMENTS.json').read_text())['models'])==5
for f in (root/'tests').glob('*.py'):ast.parse(f.read_text(encoding='utf-8'), filename=str(f))
for name in ('verify_source.py','verify_fft_reference.py'):
 subprocess.run([sys.executable,str(root/'tests'/name)],check=True)
subprocess.run([sys.executable,str(root/'tests/verify_stems.py'),str(root/'tests/fixture_synthetic_stems.zip')],check=True)
print('PASS: V3.5 cancellation, 2 unique ZIP entries, model manifest and reference tests')
