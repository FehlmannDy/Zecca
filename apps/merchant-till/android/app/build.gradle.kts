plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ch.ixh.zeccatill"
    compileSdk = 36
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "ch.ixh.zeccatill"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        // The APK in apps/merchant-till/release: a release build (no http, not debuggable), signed with the Android
        // debug key like the NFC PayLink APK, so anyone can build the same app and phones accept it as an update.
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += "META-INF/*"
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    // QR codes: encode the pay link (pure Java, no AndroidX).
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
}
