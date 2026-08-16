# Sozvon for Android

A thin Android shell around the Sozvon web client: a WebView plus the plumbing
a browser would otherwise provide — camera/microphone permission handling,
keeping the screen awake during calls, file downloads, and a list of
remembered servers.

On first launch the app asks for the address of your Sozvon (or Galène)
server over **https**. Every server you connect to is kept on the address
screen as a card — tap to open, or use its menu to rename or remove it — so
a second server no longer costs you the first. A server installed by the
deploy wizard is added to that list. **Back** on the server's first page
returns to it (during a call the app asks first, so a stray back press cannot
drop one); long-pressing the launcher icon and picking **Change server** gets
there too.

The list lives in the app's own `SharedPreferences` (`servers`, JSON); the
single `server_url` key older builds used is still written with the most
recent entry, and an existing one is migrated into the list.

A server's card menu also reaches the machine itself, over SSH, through the
same installer script the deploy wizard uses:

* **Reinstall** — run the installer over it: a newer version, or a repair for
  a service that has stopped. Rooms, invite links and the operator password
  are kept.
* **Clean reinstall** — `--purge`, then install as if the machine were new: a
  new operator password and no rooms.
* **Delete from the server** — `--uninstall`, or `--purge` with the "delete
  the data as well" box ticked. The card is dropped afterwards, since it would
  point at nothing.

SSH credentials are asked for each time. The app remembers the host key, never
the password or the private key.

The app appends `SozvonApp/<version>` to its user agent; the web client uses
this to hide its own "Download the Android app" button when already running
inside the app.

## Building

There is no Gradle wrapper checked in; use one of:

* **GitHub Actions** — the `Android APK` workflow
  (`.github/workflows/android-apk.yml`) builds a debug APK on every push
  that touches `android/`, and on demand via *Run workflow*. Download the
  `sozvon-apk` artifact.
* **Android Studio** — open the `android/` directory and run *Build APK(s)*.
* **Command line** — with JDK 17, an Android SDK (API 34) and Gradle ≥ 8.7:

  ```sh
  gradle -p android assembleDebug
  # → android/app/build/outputs/apk/debug/app-debug.apk
  ```

The debug APK is signed with a debug key, which is fine for self-hosted
distribution (Android shows the usual "unknown sources" prompt). For a
release build, configure a `signingConfig` with your own keystore in
`app/build.gradle.kts` and run `assembleRelease`.

## Distributing from your server

Copy the APK into the server's data directory:

```sh
cp app-debug.apk /path/to/server/data/sozvon.apk
```

The server then serves it at `/sozvon.apk`, and the web client's login card
automatically shows a **Download the Android app (APK)** button. Remove the
file to hide the button again.

When updating, bump `versionCode` in `app/build.gradle.kts` and keep the
signing key the same, otherwise Android refuses to install the update over
the old version.
