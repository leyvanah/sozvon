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

## Signing

Android identifies an app by its signing key. A build signed with a
different key is a *different app* to the device: it refuses to install over
the existing one, and the user has to uninstall first — losing their saved
servers and pinned certificates.

The debug key does not survive that test. It is generated per machine, so a
build from CI and a build from your laptop are two different apps, and every
hop between them costs a reinstall. **Debug builds are for throwaway testing
on one machine.** Anything that reaches somebody else's device — including
the APK you drop into the server's `data/` directory — should be an
`assembleRelease` build signed with a stable key.

Create that key once, somewhere outside this checkout:

```sh
keytool -genkeypair -keystore ~/keys/sozvon-release.jks -storetype PKCS12 \
    -alias sozvon -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=Sozvon, O=Sozvon"
```

Then name it in `~/.gradle/gradle.properties` — outside the repository, so
neither the key nor its password can be committed:

```properties
sozvonKeystore=/home/you/keys/sozvon-release.jks
sozvonKeystorePassword=…
sozvonKeyAlias=sozvon
sozvonKeyPassword=…
```

```sh
gradle -p android assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

The same four values are also read from the environment as
`SOZVON_KEYSTORE`, `SOZVON_KEYSTORE_PASSWORD`, `SOZVON_KEY_ALIAS` and
`SOZVON_KEY_PASSWORD`, which is how a CI job would take them from secrets.

If the properties are absent the release build is left **unsigned** rather
than falling back to the debug key — a silent fallback is exactly how two
differently signed "releases" end up in circulation. Check what you actually
produced before distributing it:

```sh
apksigner verify --print-certs app-release.apk
```

**Back the keystore up.** Losing it means no existing install can ever be
upgraded again; every user would have to uninstall and start over.

## Distributing from your server

Copy the APK into the server's data directory:

```sh
cp app-release.apk /path/to/server/data/sozvon.apk
```

The server then serves it at `/sozvon.apk`, and the web client's login card
automatically shows a **Download the Android app (APK)** button. Remove the
file to hide the button again.

When updating, bump `versionCode` in `app/build.gradle.kts` and sign with the
same key as last time (see *Signing* above), otherwise Android refuses to
install the update over the old version.
