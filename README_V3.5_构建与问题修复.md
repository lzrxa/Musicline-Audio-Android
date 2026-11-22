# Musicline Offline Audio V3.5 Alpha — 修复与构建

本版基于 V3.4，重点修复“用户取消”与后台队列启动之间的状态竞态，并把双轨 ZIP 唯一条目校验纳入自动化门禁。保留五个模型的下载/本地持久化管理、HQ3 与 Vocal FT 的实验性 ONNX 推理、视频转音频和音频编辑原有代码。

## 修复说明

1. 确认现有 ZIP 输出只有两个不同的 WAV 条目，并新增回归检测防止未来误写重复条目（当前 V3.4 文件中并无重复写入）。
2. `inferenceCancel` 在打开文件选择器前初始化，后台工作线程不会在处理开始时重置取消状态；压缩输出及最终发布前再次检查取消请求。
3. 发生 `OutOfMemoryError` 时清理临时 WAV 和 ZIP，避免误显示旧结果。
4. CI 新增 `tests/run_v35_checks.py` 检查，先运行离线结构与模拟音频测试，再执行 Gradle 编译。

## 生成测试 APK

将整个工程上传 GitHub 仓库，Actions → `Android debug APK (experimental)` → Run workflow。CI 通过后下载 `musicline-v3-5-experimental-debug-apk` 工件。也可以在已配置 Android SDK 的 Android Studio 打开工程，构建 debug APK。

**注意**：这里没有完成 Android SDK 构建，也没有在真实 66 MB ONNX 权重或设备上做完整模型推理测试。源码静态检查不是运行成功证明。

## 仍需验证

- MDX Inst HQ3 实际模型的输入输出、伴奏质量与手机内存占用；
- Vocal FT 的输出方向与质量；
- Karaoke、Kim Vocal 2、MDX Main 的推理适配（目前仅下载管理）；
- 连续录制、取消、后台切换、视频转音频与系统文件保存的真机回归。

首次下载的模型位于 App 私有存储；正常同签名升级不会清空，卸载或清除数据会清空。

## 重要：本地 WebView 资源路径修复

V3.4 使用 `WebViewAssetLoader.addPathHandler("/", AssetsPathHandler)`，启动 URL 是 `https://appassets.androidplatform.net/index.html`，但 HTML 和 JS 被放在 `app/src/main/assets/www/` 中。这个映射对应的实际文件却应位于 `app/src/main/assets/` 下，因此 V3.4 构建后可能白屏。V3.5 已将 `www/` 的内容移动到 `assets/` 根目录，不更改网页绝对路径；自动测试检查首页脚本与 CSS 全部存在。

## 本地实测状态

- Python 离线结构/测试音频/FFT 参考测试通过。
- `MdxEngine.java` 使用匹配实际接口的 Java 测试替身编译通过。这不是 ONNX Runtime 真实运行。
- 未在本环境编译 APK，因为这里没有 Android SDK、Gradle；请用所附 GitHub Actions 工作流执行真正的 APK 构建并观察构建日志。
