#!/usr/bin/env python3
"""V3.6 source-level invariants. Does not replace Android SDK or model inference testing."""
from pathlib import Path
import subprocess, sys, re, json
root=Path(__file__).resolve().parents[1]
subprocess.run([sys.executable,str(root/'tests/run_v35_checks.py')],check=True)
main=(root/'app/src/main/java/cn/musicline/audiooffline/MainActivity.java').read_text()
ui=(root/'app/src/main/assets/index.html').read_text()
js=(root/'app/src/main/assets/mdx-inference.js').read_text()
gradle=(root/'app/build.gradle').read_text()
assert "versionName '3.7.0-alpha'" in gradle
assert 'private final AtomicBoolean awaitingExport=new AtomicBoolean(false);' in main
assert 'awaitingExport.set(true);' in main
assert 'if(!awaitingExport.get())inferenceRunning.set(false);' in main
assert 'if(awaitingExport.get())' in main
save=main[main.index('if(request==SAVE_MDX_ZIP)'):main.index('if(request==PICK_FILE)')]
assert 'awaitingExport.set(false);' in save
assert 'inferenceRunning.set(false);' in save
assert save.index('if(pending!=null)pending.delete();') < save.index('awaitingExport.set(false);')
run=main[main.index('private void runMdx('):main.index('private static void zipFile(')]
assert 'awaitingExport.set(true);' in run
assert 'pendingExportZip.delete();pendingExportZip=null;' in run
assert 'inferenceRunning.set(false);' in run
assert 'getEnvironment()' in main
assert 'public String diagnostics()' in main
assert 'id="mdxDiagnostics"' in ui and 'id="mdxDiagnosticResult"' in ui
assert 'native.diagnostics()' in js
print('PASS: export lifecycle lock, cancellation, offline diagnostic UI and build version')
