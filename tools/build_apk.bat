@echo off
cd /d %~dp0..
python tools\check_release.py --source-only || exit /b 1
gradle --no-daemon --stacktrace :app:assembleDebug || exit /b 1
python tools\check_release.py --apk app\build\outputs\apk\debug\app-debug.apk
