# Musicline Audio Offline V3.9 Alpha — 交付说明

## 本次真实改动
- 原来双轨 ZIP 的 `ACTION_CREATE_DOCUMENT` 回调会在 Android UI 主线程同步复制整个 ZIP；现在通过 `inferencePool` 后台写入，减少 ANR 风险。
- 从用户选择目的地直到后台文件写入及关闭完成，`awaitingExport` / `inferenceRunning` 不释放，避免另一分离任务覆盖正在保存的临时 ZIP。
- 校验实际写入字节数与源文件大小；失败后尽可能移除不完整输出。注意不是所有文档提供者都允许删除，因此清理为尽力而为。
- 离线诊断中显示“后台保存中”状态。
- Android app `versionCode` 12，`versionName` 3.9.0-alpha；GitHub Actions 执行 `tests/run_v39_checks.py`。

## 如何尝试编译
1. 将本 ZIP **解压全部文件**上传到你的 GitHub 私有仓库，保留 `.github/workflows/android-debug-apk.yml` 的目录结构。
2. GitHub Actions → **Android debug APK (experimental)** → Run workflow。
3. 构建成功后到 Artifacts 下载 `musicline-v3-9-experimental-debug-apk`，其中包含 `app-debug.apk` 以及 SHA-256 摘要。
4. 如果工作流失败，保留全部 Gradle 错误日志，继续修复；**不能**只凭代码静态检查认定 APK 已完成。

可选：在已配置 Android SDK/Gradle 的电脑上打开本工程，执行 `gradle :app:assembleDebug`。

## 已实际验证 / 未验证
- 已验证：V3.5 回归检查（含模型清单与音频参考数学测试）、V3.9 后台保存静态回归检查、JS 语法、ZIP 完整性。
- 未验证：Android Gradle 真编译、安装、手机端 WebView 文件处理、真实 HQ3 10 秒推理及其音质。
- 模型权重**不在本工程内**；五模型首次下载设计仍在。当前只有 HQ3/Vocal FT 实验性推理入口。

## 应用安装后优先测试
1. 断网进入音频工具，测试 10 秒 MP3/WAV 导出。
2. 下载 HQ3 之后，断网打开本地模型预检与 10 秒 ONNX 自检。
3. 用 10 秒短音频进行分离，保存 WAV 双轨 ZIP；留意 Android 保存对话框出现之后再启动任务是否被拒绝。
4. 拔掉网络再次运行已下载模型；确认导出结果可打开。

**说明**：此包是 Android Studio 工程源码，不是已经构建或已验证的 APK。
