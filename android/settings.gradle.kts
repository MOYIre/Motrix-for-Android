// Motrix for Android — Gradle settings.
//
// The APK is assembled from prebuilt artifacts (see scripts/android/): the
// jniLibs directory holds the Node interpreter, the aria2 engine and the
// finalize sidecar plus their shared libraries, and assets/runtime.zip holds
// the server bundle together with its production node_modules. This module
// therefore only packages an application shell around those artifacts.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "motrix-android"
include(":app")
