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

val fetchServerRelease by tasks.registering {
    val outDir = layout.projectDirectory.dir("src/main/assets/server").asFile
    // Declared so Gradle can skip the task when nothing changed; a release
    // tag is immutable, so the version alone decides.
    inputs.property("version", serverVersion)
    inputs.property("repo", serverRepo)
    outputs.dir(outDir)
    doLast {
        outDir.mkdirs()
        val base = "https://github.com/$serverRepo/releases/download/$serverVersion"
        fun fetch(name: String, target: File) {
            if (target.exists() && target.length() > 0L) return
            logger.lifecycle("fetching $name")
            URL("$base/$name").openStream().use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            }
            if (target.length() == 0L) {
                throw GradleException("$name downloaded empty from $base")
            }
        }
        val sums = File(outDir, "SHA256SUMS")
        fetch("SHA256SUMS", sums)
        // A manifest of what actually shipped, so the app does not have to
        // guess which architectures this build carries or how big they are:
        // asset sizes are not reliably readable once packed.
        val manifest = StringBuilder()
        for (arch in serverArches) {
            val name = "sozvon_${serverVersion}_linux_$arch.tar.gz"
            val f = File(outDir, name)
            fetch(name, f)
            // The release's own checksum, checked here rather than trusting
            // the download: a corrupt archive baked into an APK would only
            // surface on someone else's server.
            val digest = MessageDigest.getInstance("SHA-256")
            f.inputStream().use { s ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = s.read(buf)
                    if (n <= 0) break
                    digest.update(buf, 0, n)
                }
            }
            val got = digest.digest().joinToString("") { "%02x".format(it) }
            val want = sums.readLines()
                .firstOrNull { it.trimEnd().endsWith(" $name") || it.trimEnd().endsWith("*$name") }
                ?.trim()?.substringBefore(' ')
                ?: throw GradleException("SHA256SUMS has no entry for $name")
            if (got != want) {
                throw GradleException("checksum mismatch for $name: got $got, expected $want")
            }
            manifest.append(arch).append(' ').append(f.length()).append('\n')
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
        versionCode = 1
        versionName = "0.1"
    }

    buildFeatures {
        buildConfig = true
    }

    androidResources {
        // The release archives are gzip already.  Packing them again gains
        // nothing, costs build time, and -- worse -- a compressed asset
        // cannot be streamed straight out of the APK.
        noCompress += "gz"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
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
