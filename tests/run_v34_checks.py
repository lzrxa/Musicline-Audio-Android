#!/usr/bin/env python3
"""Build-independent source checks; NOT an ONNX inference or APK test."""
import ast, json, subprocess, sys, zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
for f in (root/'tests').glob('*.py'):ast.parse(f.read_text(encoding='utf-8'), filename=str(f))
main=(root/'app/src/main/java/cn/musicline/audiooffline/MainActivity.java').read_text()
assert 'while((n=check.read(buffer))!=-1)' in main and 'crc.getValue()!=entry.getCrc()' in main
assert 'android.content' not in main or 'import android.content.Intent;' in main
assert 'intent.setType("audio/wav")' in main
assert 'pendingExportZip.delete()' in main
assert (root/'.github/workflows/android-debug-apk.yml').is_file()
assert len(json.loads((root/'MODEL_REQUIREMENTS.json').read_text())['models'])==5
subprocess.run([sys.executable,str(root/'tests/verify_source.py')],check=True)
subprocess.run([sys.executable,str(root/'tests/verify_fft_reference.py')],check=True)
subprocess.run([sys.executable,str(root/'tests/verify_stems.py'),str(root/'tests/fixture_synthetic_stems.zip')],check=True)
print('PASS: V3.4 offline source, reference FFT and synthetic export checks')
