#!/usr/bin/env python3
"""V3.9 regression checks for asynchronous storage export lifecycle."""
from pathlib import Path
import subprocess, sys, re
root=Path(__file__).resolve().parents[1]
# Earlier suites include their own version assertions; reuse the stable V3.5–V3.7 checks.
for name in ('run_v35_checks.py',):
    p=subprocess.run([sys.executable,str(root/'tests'/name)],capture_output=True,text=True)
    if p.returncode:
        print(p.stdout,p.stderr,file=sys.stderr)
        raise SystemExit(name+' failed')
s=(root/'app/src/main/java/cn/musicline/audiooffline/MainActivity.java').read_text()
section=s[s.index('if(request==SAVE_MDX_ZIP){'):s.index('if(request==PICK_FILE)')]
assert 'inferencePool.submit(()->{' in section
assert 'getContentResolver().openOutputStream(dest,"w")' in section
assert 'bytes!=expected' in section
assert 'exportCopying.set(false);awaitingExport.set(false);inferenceRunning.set(false)' in section
assert section.index('inferencePool.submit(()->{') < section.index('new FileInputStream(pending)')
assert 'versionName \'3.9.0-alpha\'' in (root/'app/build.gradle').read_text()
assert '"exportCopying"' in s
assert 'exportCopying' in (root/'app/src/main/assets/mdx-inference.js').read_text()
print('PASS: V3.9 asynchronous export + task lock lifecycle checks')
