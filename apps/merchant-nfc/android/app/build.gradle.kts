plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ch.ixh.nfcpaylink"
    compileSdk = 36
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "ch.ixh.nfcpaylink"
        minSdk = 24
        targetSdk = 36
        versionCode = 4
        versionName = "0.4"
        // Hosts whose /pay/ links this app may send over NFC (see PayLinkPolicy, README.md).
        val hosts = providers.gradleProperty("zeccaNfcHosts").getOrElse("")
        buildConfigField("String", "PAYLINK_HOSTS", "\"$hosts\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
