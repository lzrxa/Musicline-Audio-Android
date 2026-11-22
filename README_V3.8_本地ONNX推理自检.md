# Musicline Audio Offline V3.8 — 本地真实推理自检

本版在 V3.7 基础上新增安卓原生 **10 秒合成音频 ONNX 推理自检**。这是为了避免将模型图可加载误认为模型能够正确处理实际数据。

## 使用

1. 先通过 Android Studio 或 GitHub Actions 尝试编译安装本工程。构建成功并不意味着自检已通过。
2. 在 APP 中选择 MDX Inst HQ3 或 MDX Vocal FT，并下载或导入模型。
3. 点击“检查所选 ONNX 模型兼容性”，然后点击“运行 10 秒离线推理自检”。
4. APP 在私有临时目录生成 44.1 kHz 双声道、10 秒合成音频，执行真实 ONNX Runtime 推理，检查双轨 WAV 文件大小、采样率和长度，然后删除测试文件。该过程不会上传音频。
5. 自检成功仅证明 *推理通路与文件格式* 在该设备上运行成功；不能证明人声伴奏分离音质。接下来必须用自己有权使用的歌曲人工试听，并完成不同手机的稳定性测试。

## 未完成的内容

- 当前环境未安装 Android SDK / Gradle，未实际编译 APK。
- 未获取真实 ONNX 权重，因此本环境未运行真实模型推理。
- 其余 Kim Vocal 2、MDX Karaoke、MDX Main 仍待按模型规格适配推理。
- 当前原生实验性 AI 推理仍限制 PCM16 WAV 输入、最长 90 秒。不能保证完整歌曲音质或性能。

## 自动构建

仓库 Actions → Android debug APK (experimental)。此流程在 GitHub runner 上安装 SDK、执行静态测试并尝试 `gradle :app:assembleDebug`，成功后生成 APK 和 SHA-256 文件。建议先用分支测试，不要直接替换现有生产版本。
