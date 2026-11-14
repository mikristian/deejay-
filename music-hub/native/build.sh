#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
ROOT="${SCRIPT_DIR:h:h}"
APP="$HOME/Applications/Rekordbox Music Hub.app"
CONTENTS="$APP/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Rekordbox Music Hub</string>
<key>CFBundleDisplayName</key><string>Rekordbox Music Hub</string>
<key>CFBundleIdentifier</key><string>com.mikristian.rekordboxmusichub</string>
<key>CFBundleExecutable</key><string>RekordboxMusicHub</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>11.3</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleIconFile</key><string>MusicHub</string>
</dict></plist>
PLIST
swiftc -O -framework AppKit -framework WebKit "$SCRIPT_DIR/MusicHub.swift" -o "$CONTENTS/MacOS/RekordboxMusicHub"
if [ -f "$SCRIPT_DIR/MusicHub.icns" ]; then
  cp "$SCRIPT_DIR/MusicHub.icns" "$CONTENTS/Resources/MusicHub.icns"
fi
codesign --force --sign - "$APP"
codesign --verify --verbose=2 "$APP"
echo "$APP"
