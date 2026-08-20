import java.io.File
import java.net.URL
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The server installer is NOT vendored here.  contrib/install.sh at the root
// of the repository is the single source -- the same script a person runs by
// hand, and the one that is actually tested -- and it is copied into the
// assets before every build.  A checked-in second copy silently went stale
// once already: the app shipped an installer that did not know the options
// the app had learned to pass, so the deploy failed with "unknown option".
val syncInstaller by tasks.registering(Copy::class) {
    val source = rootProject.file("../contrib/install.sh")
    from(source)
    into(layout.projectDirectory.dir("src/main/assets"))
    doFirst {
        if (!source.exists()) {
            throw GradleException(
                "contrib/install.sh not found at ${source.absolutePath}. " +
                    "Build the app from a full checkout of the Sozvon repository."
            )
        }
    }
}

// The server release travels inside the APK as well, so the app can install a
// server that cannot reach GitHub -- which, on Russian hosting, is the usual
// case: github.com and api.github.com time out while the rest of the internet
// works, and the installer's fetch stage then fails with a message about a
// flag the app never shows.  The app uploads this copy over the SSH
// connection it already has and points the installer at it with --mirror,
// which is an ordinary, already tested path through the script.
//
// Downloaded at build time rather than committed: 17 MB of binaries per
// release does not belong in a git history, and CI (where these builds
// happen) can reach GitHub perfectly well.  Pinned by version so a build is
// reproducible -- see sozvonServerVersion in gradle.properties.
val serverVersion = (project.findProperty("sozvonServerVersion") as String?) ?: "v0.2.0"
val serverRepo = (project.findProperty("sozvonServerRepo") as String?) ?: "leyvanah/sozvon"
val serverArches = listOf("amd64", "arm64")

// Testing a server change used to require releasing it first: the only way
// into the APK was a GitHub release URL, so an unreleased build could not be
// carried to a machine by the app that exists to carry servers to machines.
// -PsozvonServerDir=<dir> takes the archives from a directory instead, named
// as the release names them (sozvon_<version>_linux_<arch>.tar.gz), and
// computes the checksums here rather than checking them against a release
// that does not exist.
//
// Release builds keep the default path deliberately: fetching the published
// archive and verifying it against the published SHA256SUMS is what makes a
// shipped APK's provenance checkable, and a local directory cannot offer
// that.  (Sozvon)
val serverDir = (project.findProperty("sozvonServerDir") as String?)
    ?.takeIf { it.isNotBlank() }

val fetchServerRelease by tasks.registering {
    val outDir = layout.projectDirectory.dir("src/main/assets/server").asFile
    // Declared so Gradle can skip the task when nothing changed; a release
    // tag is immutable, so the version alone decides.
    inputs.property("version", serverVersion)
    inputs.property("repo", serverRepo)
    inputs.property("dir", serverDir ?: "")
    outputs.dir(outDir)
    doLast {
        outDir.mkdirs()
        // Anything left from an earlier version -- or from an earlier naming
        // scheme -- would otherwise be packaged alongside the current one and
        // quietly bloat the APK.
        val expected = serverArches.map { "$it.pkg" } +
            listOf("SHA256SUMS", "latest", "manifest")
        outDir.listFiles()?.forEach { f ->
            if (f.name !in expected) {
                logger.lifecycle("removing stale asset ${f.name}")
                f.delete()
            }
        }
        val base = "https://github.com/$serverRepo/releases/download/$serverVersion"
        fun fetch(name: String, target: File) {
            if (serverDir != null) {
                // Always re-copy: a local build changes while its version
                // string stays put, so "the file is already there" is not
                // evidence that it is the right one.
                val source = File(serverDir, name)
                if (!source.isFile || source.length() == 0L) {
                    throw GradleException(
                        "sozvonServerDir=$serverDir has no $name. Build the " +
                            "server for each architecture and package it as " +
                            "the release does."
                    )
                }
                logger.lifecycle("taking $name from $serverDir")
                source.copyTo(target, overwrite = true)
                return
            }
            if (target.exists() && target.length() > 0L) return
            logger.lifecycle("fetching $name")
            URL("$base/$name").openStream().use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            }
            if (target.length() == 0L) {
                throw GradleException("$name downloaded empty from $base")
            }
        }
        fun sha256(f: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            f.inputStream().use { s ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = s.read(buf)
                    if (n <= 0) break
                    digest.update(buf, 0, n)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
        val sums = File(outDir, "SHA256SUMS")
        // With a local directory there is no published SHA256SUMS to fetch or
        // to check against; we write one so that everything downstream -- the
        // app's uploaded mirror, install.sh's own verification -- works
        // exactly as it does for a release.
        if (serverDir == null) {
            fetch("SHA256SUMS", sums)
        }
        // A manifest of what actually shipped, so the app does not have to
        // guess which architectures this build carries or how big they are:
        // asset sizes are not reliably readable once packed.
        val manifest = StringBuilder()
        val localSums = StringBuilder()
        for (arch in serverArches) {
            val name = "sozvon_${serverVersion}_linux_$arch.tar.gz"
            // Stored under a neutral extension on purpose.  The Android
            // packager treats a ".gz" asset as something to unwrap: it
            // gunzips the file and drops the extension, so an asset named
            // *.tar.gz arrives in the APK as a 21 MB *.tar that no longer
            // matches the release's checksum and no longer has the name the
            // app looks for.  ".pkg" is passed through untouched; the archive
            // gets its real name back when it lands on the server.
            val f = File(outDir, "$arch.pkg")
            fetch(name, f)
            val got = sha256(f)
            if (serverDir != null) {
                // Nothing to check against -- record what we have, in the
                // format the rest of the chain reads.
                localSums.append(got).append("  ").append(name).append('\n')
            } else {
                // The release's own checksum, checked here rather than
                // trusting the download: a corrupt archive baked into an APK
                // would only surface on someone else's server.
                val want = sums.readLines()
                    .firstOrNull { it.trimEnd().endsWith(" $name") || it.trimEnd().endsWith("*$name") }
                    ?.trim()?.substringBefore(' ')
                    ?: throw GradleException("SHA256SUMS has no entry for $name")
                if (got != want) {
                    throw GradleException("checksum mismatch for $name: got $got, expected $want")
                }
            }
            manifest.append(arch).append(' ').append(f.length()).append('\n')
        }
        if (serverDir != null) {
            sums.writeText(localSums.toString())
        }
        File(outDir, "latest").writeText(serverVersion)
        File(outDir, "manifest").writeText(manifest.toString())
    }
}

tasks.named("preBuild") { dependsOn(syncInstaller, fetchServerRelease) }

android {
    namespace = "org.sozvon.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.sozvon.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.1"
    }

    buildFeatures {
        buildConfig = true
    }

    androidResources {
        // The release archives are gzip already.  Packing them again gains
        // nothing, costs build time, and -- worse -- a compressed asset
        // cannot be streamed straight out of the APK.
        noCompress += "pkg"
    }

    // Android identifies an app by its signing key, and refuses to install a
    // build signed with a different one over an existing install: the user
    // has to uninstall first, losing their saved servers and pinned
    // certificates.  The debug key does not survive that test -- it is
    // generated per machine, so a build from CI and a build from a laptop are
    // two different apps to the device, and every hop between them costs a
    // reinstall.
    //
    // So anything meant to reach a device is signed with a stable key that
    // lives OUTSIDE this repository.  The four properties below are read from
    // ~/.gradle/gradle.properties (or -P on the command line, or the matching
    // SOZVON_* environment variables in CI); the keystore is never committed
    // and its password is never in the build files.  When they are absent the
    // release build is simply left unsigned rather than falling back to the
    // debug key, because a silent fallback is exactly how two differently
    // signed "releases" get distributed.  (Sozvon)
    val keystorePath = providers.gradleProperty("sozvonKeystore")
        .orElse(providers.environmentVariable("SOZVON_KEYSTORE"))
        .orNull?.takeIf { it.isNotBlank() }
    val keystorePassword = providers.gradleProperty("sozvonKeystorePassword")
        .orElse(providers.environmentVariable("SOZVON_KEYSTORE_PASSWORD"))
        .orNull?.takeIf { it.isNotBlank() }
    val keyAliasName = providers.gradleProperty("sozvonKeyAlias")
        .orElse(providers.environmentVariable("SOZVON_KEY_ALIAS"))
        .orNull?.takeIf { it.isNotBlank() }
    val keyPasswordValue = providers.gradleProperty("sozvonKeyPassword")
        .orElse(providers.environmentVariable("SOZVON_KEY_PASSWORD"))
        .orNull?.takeIf { it.isNotBlank() }

    val signingReady = keystorePath != null && keystorePassword != null &&
        keyAliasName != null && keyPasswordValue != null &&
        file(keystorePath).exists()

    if (signingReady) {
        signingConfigs {
            create("sozvon") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = keyAliasName
                keyPassword = keyPasswordValue
            }
        }
    } else if (keystorePath != null) {
        logger.warn(
            "sozvonKeystore is set to $keystorePath but the file is missing " +
                "or a password/alias property is absent; the release build " +
                "will be unsigned."
        )
    }

    buildTypes {
        release {
            // Shrinking is off, deliberately, and the keep rules stay in
            // proguard-rules.pro for whenever it goes back on.
            //
            // Until now CI only ever built *debug*, so this build type had
            // never actually run anywhere.  Its first run failed at the first
            // SSH connection: R8 had removed 411 JSch classes, which JSch
            // loads by name, and the deploy died with ClassNotFoundException
            // on a rented server rather than on anyone's desk.  Keep rules fix
            // that particular hole, but 5350 classes were removed in all and
            // no test we can run here proves the rest are unused -- the
            // evidence would again arrive as a failed install on somebody
            // else's machine.
            //
            // What shrinking buys is a fraction of a megabyte of code inside
            // an APK whose bundled server payload is nearly seventeen.  That
            // is not worth a class of failure that is invisible until the
            // app's most valuable feature runs against a real host.
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (signingReady) {
                signingConfig = signingConfigs.getByName("sozvon")
            }
        }
        // Debug keeps the per-machine key on purpose: throwaway builds should
        // not be able to masquerade as an update to something a user
        // installed.  Use assembleRelease for anything that leaves the
        // machine.
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")

    // SSH client for "deploy your own server".  mwiede/jsch is the maintained
    // fork of JSch: pure Java (so it needs no NDK), small, and it still
    // supports the modern key exchanges and host key types that a current
    // OpenSSH server offers.  The original com.jcraft:jsch is abandoned and
    // negotiates nothing a 2020s sshd will accept.
    implementation("com.github.mwiede:jsch:0.2.18")
}
