#!/bin/bash
# Start Android emulator + install + run pi mobile app
# Usage: ./emulate.sh [--build]

set -e

export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
export JAVA_HOME="${JAVA_HOME:-D:/envs/sdks/jdk-17.0.10+7}"
APK="android/app/build/outputs/apk/debug/app-debug.apk"

cd "$(dirname "$0")"

# Optional: rebuild first
if [[ "$1" == "--build" ]]; then
    echo ">>> Building..."
    npm run build
    npx cap sync android
    cd android && ./gradlew assembleDebug --no-daemon && cd ..
fi

# Check if emulator is already running
BOOTED=$("$ANDROID_HOME/platform-tools/adb.exe" devices 2>/dev/null | grep -c "emulator" || true)

if [[ "$BOOTED" -eq 0 ]]; then
    echo ">>> Starting emulator..."
    # Pick first available AVD
    AVD=$("$ANDROID_HOME/emulator/emulator.exe" -list-avds 2>/dev/null | head -1)
    if [[ -z "$AVD" ]]; then
        echo "ERROR: No AVD found. Create one with:"
        echo "  \$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd -n pi-test -k 'system-images;android-34;google_apis;x86_64' -d 'pixel_6'"
        exit 1
    fi
    echo "    Using AVD: $AVD"
    # Start emulator in background (no window mode for headless, or remove -no-window for GUI)
    "$ANDROID_HOME/emulator/emulator.exe" -avd "$AVD" -no-snapshot-load &
    EMU_PID=$!
    echo "    Waiting for boot..."
    "$ANDROID_HOME/platform-tools/adb.exe" wait-for-device
    # Wait for boot complete
    for i in $(seq 1 60); do
        BOOT=$("$ANDROID_HOME/platform-tools/adb.exe" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
        if [[ "$BOOT" == "1" ]]; then break; fi
        sleep 1
    done
    echo "    Emulator ready (PID $EMU_PID)"
else
    echo ">>> Emulator already running"
fi

# Install APK
echo ">>> Installing APK..."
"$ANDROID_HOME/platform-tools/adb.exe" install -r "$APK"

# Launch app
echo ">>> Launching app..."
"$ANDROID_HOME/platform-tools/adb.exe" shell am start -n com.pi.mobile/.MainActivity

echo ">>> Done! App running on emulator."
echo "    Logs: adb logcat -s WebView chromium"
echo "    Debug: chrome://inspect in Chrome"
echo ""
echo "    Press Ctrl+C to stop (emulator keeps running)"
wait
