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

tasks.named("preBuild") { dependsOn(syncInstaller) }

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
