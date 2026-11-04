plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.gsb.signage"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.gsb.signage"
        minSdk = 24          // Android 7 — cobre TV boxes antigos
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        // Ajuste para o endereço do seu servidor (VPS, túnel ou IP fixo na LAN)
        buildConfigField("String", "SERVER_URL", "\"http://192.168.0.10:4000\"")
    }

    buildFeatures { buildConfig = true }
    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.json:json:20240303")
}
