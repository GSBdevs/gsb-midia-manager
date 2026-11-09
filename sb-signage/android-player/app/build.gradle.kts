plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.gsb.signage"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.gsb.signage"
        minSdk = 24          // Android 7: cobre TV boxes antigos
        targetSdk = 34
        versionCode = 2
        versionName = "2.0.0"
        // Vazio = o app pergunta o endereço na primeira execução.
        // Para entregar já configurado: ./gradlew assembleRelease -PserverUrl=https://telas.cliente.com.br
        val serverUrl = (project.findProperty("serverUrl") as String?) ?: ""
        buildConfigField("String", "DEFAULT_SERVER", "\"$serverUrl\"")
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }
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
    implementation("io.socket:socket.io-client:2.1.1") {
        exclude(group = "org.json", module = "json") // o Android já traz org.json
    }

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
