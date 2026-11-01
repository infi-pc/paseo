# Build the personal iOS app for TestFlight

The fork uses `cz.infi.paseo` on Apple Developer team `UQAKP649X7`, with the
display name **Paseo Personal**. It builds locally with Xcode. The `testflight`
variant excludes upstream's Expo project and Firebase files; the upstream EAS
release profiles still belong to upstream.

## Set up signing once

1. Install a released version of Xcode and finish its first-launch setup. Check
   [Apple's current Xcode requirements](https://developer.apple.com/xcode/system-requirements)
   before changing toolchains. Builds from Xcode 27.2 (`27B52`) upload; App Store
   Connect rejected them with error `90534` for a few days after that Xcode
   release. Install CocoaPods (`brew install cocoapods`) and run `npm ci` in the repository.
2. In Xcode → Settings → Accounts, sign into the Apple account that belongs to
   team `UQAKP649X7`. The team needs an active paid Apple Developer membership.
   Allow Xcode to manage distribution signing and provisioning.
3. In Apple Developer, register the explicit App ID `cz.infi.paseo`. In App Store
   Connect, create an iOS app with that bundle ID, English as its primary language,
   and a unique SKU such as `paseo-personal`. The numeric App Store Connect app ID
   is separate from the bundle ID; local export does not need it.

## Archive and export

From the repository root:

```bash
npm run build:ios:testflight -- 2
```

To select a different installed Xcode for this command, set `DEVELOPER_DIR` to its
`Contents/Developer` directory. Keep the selected toolchain unchanged throughout
the archive and export.

Use a larger positive build number for every upload, even when the repository
version has not changed. This number is independent of upstream's release
numbering. The app version still follows `packages/app/package.json`.

The command regenerates `packages/app/ios` for the personal identity, installs
Pods, archives a Release build for a physical iOS device, and exports an IPA to
`artifacts/ios-testflight/2/`. It replaces any generated simulator project in that
directory. Stop simulator builds before running it. Archives stay local and the
command does not upload anything. TestFlight builds compile Expo modules from
source so their debug symbols can be included in the archive.

Open the `.xcarchive` in Xcode Organizer and choose **Distribute App → App Store
Connect**, or upload the exported `.ipa` with Apple's Transporter app. Select
the `cz.infi.paseo` app. Wait for App Store Connect to finish processing it, then
add the build to an internal TestFlight testing group and invite your Apple ID.
External testers require Apple's Beta App Review.

Export signs with Apple's cloud-managed distribution certificate, so no local
distribution key or keychain password is needed. Xcode prefers a local
**Apple Distribution** identity when one is in the keychain search list, though.
On this Mac, Hello Dino's `HelloDinoDistribution` keychain holds one. When that
keychain is locked, export fails with `errSecInternalComponent`. Take the keychain
out of the search list for the export, then put it back:

```bash
security list-keychains -d user -s ~/Library/Keychains/login.keychain-db
# run the export or upload
security list-keychains -d user -s ~/Library/Keychains/login.keychain-db \
  ~/.config/hello-dino/signing/HelloDinoDistribution.keychain-db
```

To upload from the command line, rerun `xcodebuild -exportArchive` with
`destination` set to `upload` in the export options. The existing archive can be
exported again without rebuilding.

## Check the installed app

Pair with the fork daemon using its QR code. On a physical phone, `localhost`
means the phone; use your Mac's reachable network address or the relay pairing
link. Allow camera access for scanning and local network access for LAN hosts.
Check workspace navigation, agent messages, sending a prompt, backgrounding and
reopening the app, attachments, and microphone permission on the real device.

Push notifications go through the personal Expo project `infi-paseo`
(`packages/app/testflight/config.js`); do not reuse upstream's project ID or APNs
keys. Expo needs an APNs key (`.p8`) from team `UQAKP649X7` in that project's iOS
push credentials for `cz.infi.paseo`. Without it, the app registers a token but
Expo cannot deliver to it. Add the key with
`APP_VARIANT=testflight npx eas credentials -p ios` and the `testflight` profile;
the web wizard demands a distribution certificate, which cloud signing does not
have. Delete `packages/app/ios` first: with a generated project present, config
introspection fails because scene support is already declared.

The app retains
the `paseo` URL scheme for daemon pairing links. If upstream's app is also installed,
the OS may open those links in either app; prefer scanning the QR code inside
Paseo Personal.

See [development.md](development.md#running-the-ios-app-on-a-local-simulator) for
simulator development and [notifications.md](notifications.md) for notification
behavior.
