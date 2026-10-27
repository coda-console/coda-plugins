#!/bin/sh
# 编译并签名黑屏 App（iPhone 与 iPad 通用），不装到设备：装经测试机插件的 use-testbed（app 给产物路径），见 README.md。
# 用法：build.sh <输出目录> <描述文件名>。签名用登录钥匙串里的 Apple Development 证书与这份开发描述文件（须是通配 App ID、包含目标设备），
# Team 取自描述文件。在 Coda 会话里交给持锁执行（run-held）运行，或在占着组 host 的流程步骤里：它经 host-sim 占构建名额。
set -eu
[ $# -eq 2 ] || { echo "用法：$0 <输出目录> <描述文件名>" >&2; exit 2; }
# 已在构建名额里才直接编译；测试机上执行的命令也带 HOST_SIM_LEASE，但占的不是构建名额，所以问 host-sim。
if ! host-sim check --kind build 2>/dev/null; then
  exec host-sim run --kind build -- sh "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" "$@"
fi
# blackscreen.mjs 默认打开的就是这个 Bundle ID。
BUNDLE_ID=com.leavan.blackscreen
PROFILE_NAME="$2"
mkdir -p "$1"
APP="$(cd "$1" && pwd)/BlackScreen.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
rm -rf "$APP"; mkdir -p "$APP"

profile=""
for candidate in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision; do
  security cms -D -i "$candidate" > "$WORK/profile.plist" 2>/dev/null || continue
  if [ "$(plutil -extract Name raw -o - "$WORK/profile.plist")" = "$PROFILE_NAME" ]; then profile="$candidate"; break; fi
done
[ -n "$profile" ] || { echo "找不到描述文件：$PROFILE_NAME" >&2; exit 1; }
TEAM="$(plutil -extract TeamIdentifier.0 raw -o - "$WORK/profile.plist")"
identity=$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $2; exit}')
[ -n "$identity" ] || { echo "登录钥匙串里没有 Apple Development 证书" >&2; exit 1; }

xcrun -sdk iphoneos swiftc -target arm64-apple-ios17.0 -O -parse-as-library \
  "$(dirname "$0")/BlackScreen.swift" -o "$APP/BlackScreen"

cat > "$APP/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>BlackScreen</string>
  <key>CFBundleName</key><string>黑屏</string>
  <key>CFBundleDisplayName</key><string>黑屏</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
  <key>UIRequiresFullScreen</key><true/>
  <key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>
  <key>UILaunchScreen</key><dict/>
  <key>UIUserInterfaceStyle</key><string>Dark</string>
  <key>UIStatusBarHidden</key><true/>
</dict></plist>
PLIST
cp "$profile" "$APP/embedded.mobileprovision"

cat > "$WORK/entitlements.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>application-identifier</key><string>$TEAM.$BUNDLE_ID</string>
  <key>com.apple.developer.team-identifier</key><string>$TEAM</string>
  <key>get-task-allow</key><true/>
</dict></plist>
PLIST
codesign --force --sign "$identity" --entitlements "$WORK/entitlements.plist" --timestamp=none "$APP"
codesign --verify --strict "$APP"
echo "$APP"
