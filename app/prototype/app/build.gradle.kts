plugins {
    id("com.android.application")
}

android {
    namespace = "com.huobao.a1probe"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.huobao.a1probe"
        minSdk = 26
        targetSdk = 28
        versionCode = 1
        versionName = "0.1-a1"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
    }

    lint {
        abortOnError = false
    }
}
