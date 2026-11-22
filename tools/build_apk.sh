#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tools/check_release.py --source-only
if ! command -v gradle >/dev/null; then
 echo 'ERROR: Gradle is not installed. Use Android Studio or GitHub Actions.' >&2
 exit 2
fi
if [[ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]]; then
 echo 'ERROR: Android SDK path missing (ANDROID_HOME).' >&2
 exit 2
fi
gradle --no-daemon --stacktrace :app:assembleDebug
python3 tools/check_release.py --apk app/build/outputs/apk/debug/app-debug.apk
