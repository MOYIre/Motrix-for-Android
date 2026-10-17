import java.util.Properties

// Application shell for Motrix on Android.
//
// There are no library dependencies on purpose: the module is a WebView plus a
// foreground service that supervises the bundled Node server, and everything it
// runs comes from prebuilt artifacts staged into `src/main/jniLibs` and
// `src/main/assets` by scripts/android/package-runtime.mjs.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android") version "2.0.21"
}

val keystorePropertiesFile = rootProject.file("keystore/keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

android {
    namespace = "com.motrix.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.motrix.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 2_000_000
        versionName = "2.0.0-beta.49"
        ndk {
            // Single-ABI build: the runtime artifacts are aarch64 only.
            abiFilters += "arm64-v8a"
        }
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs {
            // Keep the runtime binaries as real files on disk: Android refuses
            // to execute anything outside the native library directory.
            useLegacyPackaging = true
        }
        resources {
            excludes += "/META-INF/**"
        }
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}
