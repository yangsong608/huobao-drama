plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.huobao.drama"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.huobao.drama"
        minSdk = 26
        // A1 真机结论：targetSdk 28 才能从应用私有目录执行 proot 与运行时二进制
        targetSdk = 28
        versionCode = 1
        versionName = "4.0.35"

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // 签名配置由发布流程注入，仓库不保存密钥
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    androidResources {
        // 运行时分卷已是 zstd 压缩，APK 内必须原样存储，避免二次压缩与解压峰值
        noCompress += "zst"
        noCompress.addAll(
            listOf(
                "part-000", "part-001", "part-002", "part-003", "part-004",
                "part-005", "part-006", "part-007", "part-008", "part-009",
            ),
        )
    }

    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
        resources {
            excludes += setOf(
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
                "META-INF/LICENSE.txt",
                "META-INF/NOTICE.txt",
            )
        }
    }

    lint {
        abortOnError = false
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("com.google.zxing:core:3.5.3")
    implementation("org.apache.commons:commons-compress:1.27.1")
    implementation("com.github.luben:zstd-jni:1.5.7-12@aar")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("com.github.luben:zstd-jni:1.5.7-12")
    testImplementation("org.apache.commons:commons-compress:1.27.1")
}
