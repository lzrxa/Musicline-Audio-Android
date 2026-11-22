# Musicline Audio Offline V3.7 Alpha — 实际验证指引

本版以 V3.6 工程为基础，保留五模型首次下载并保存到手机私有存储的管理机制，**并未附带实际模型权重**。

## V3.7 新增

1. 安卓 AI 页面新增「检查所选 ONNX 模型兼容性」按钮。它使用 Android ONNX Runtime **在设备本地加载所选 HQ3 或 Vocal FT 文件**，确认模型仅有一个输入和一个输出，且维度兼容 `[1,4,3072,256]`（动态维度容许为负数）。输出具体的输入输出尺寸。不会上传模型或音频。
2. 模型预检和音频分离共用单线程推理任务队列与运行锁，避免在保存窗口打开时加载另一个模型。
3. GitHub Actions 生成 Debug APK 后，检查 APK ZIP 结构、AndroidManifest、classes.dex 和离线主页存在，并生成 `.sha256` 校验文件；构建失败则不会上传虚假的 APK。
4. 继续执行 V3.3–V3.6 的音频合成数据与源码回归测试。

## APK 构建（需要联网的开发环境）

工程根目录推送到 GitHub 仓库，打开 Actions → `Android debug APK (experimental)` → Run workflow。若成功，在 Artifacts 下载 `musicline-v3-7-experimental-debug-apk`，其中有 APK 和 SHA256。也可在本机安装 Android Studio / JDK 17 / Android SDK 35，运行 `gradle :app:assembleDebug`。

**注意：当前环境未安装 Android SDK / Gradle，也未取得真实 ONNX 权重，无法验证上述构建会成功，不能把项目 ZIP 当 APK。**

## 手机上测试的正确顺序

1. 安装 Debug APK，进入 AI 模型，下载 MDX Inst HQ3 或通过导入功能选择可信 ONNX 文件；完成模型哈希验证。
2. 选择 HQ3，点击「检查所选 ONNX 模型兼容性」。看反馈是否与 `[1,4,3072,256]` 一致。模型图通过只代表可加载且接口维度匹配，**不代表分离音质正确**。
3. 导入 10 秒左右的双声道 PCM16 WAV（44.1 kHz），完成推理后保存两轨 ZIP，检查每条音轨能播放、时长一致、内容符合预期。
4. 开启飞行模式，重新运行同一文件确认本地离线工作。
5. 真机记录内存峰值、耗时、崩溃日志，再决定是否允许长于 10 秒的片段及适配其他模型。

## 当前限制

- 只有 HQ3、Vocal FT 具备实验性 MDX 频谱推理代码；Karaoke、Kim Vocal 2、MDX Main 仍仅有模型管理。
- 输入仅限 PCM16 WAV，最长 90 秒；模型推理没有真实权重和安卓真机验证。
- 模型首次下载后存储在 App 私有目录；卸载应用或清除数据会删除已下载模型。
- GitHub Actions 工程提供的是构建方案，并不是本次已经生成的 APK。
