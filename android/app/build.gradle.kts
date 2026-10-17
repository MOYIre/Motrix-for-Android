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
            // The key never lives in the repository. The cloud build decrypts
            // it (from GitHub Actions secrets) into the build directory; when
            // the secrets are missing the release falls back to the platform
            // debug signing so builds keep working.
            val store = rootProject.layout.buildDirectory
                .file("keystore/release.jks").get().asFile
            if (store.isFile) {
                storeFile = store
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
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
