# Musicline Audio Offline V3.6 Alpha — 交付说明

## 本次实质修改
- 修复分离完成后系统保存窗口仍打开时，可以启动第二次分离并删除上一份待保存 ZIP 的竞态问题。
- 现在从选择 WAV 到选择保存位置（或取消保存）整个周期保持任务锁；保存界面关闭后自动解锁。
- 如果系统保存对话框无法启动，会删除暂存 ZIP、恢复任务状态并提示错误。
- ONNX 页面新增「检查离线运行环境」按钮，报告运行库能否初始化、模型目录是否可写、手机可用空间与任务状态。
- 添加 `tests/run_v36_checks.py` 和更新 GitHub Actions 工作流以运行该检查。

## 已验证
- V3.5 源码检查、模拟频谱往返、WAV/ZIP 结构测试与新增 V3.6 状态守卫检查通过。
- JavaScript 静态解析与 ZIP 完整性在打包时进行。

## 未验证（不能误称完成）
- Android SDK/Gradle 真实 assembleDebug 未运行；没有可安装 APK。
- ONNX Runtime 是否在真实安卓设备加载、HQ3/Vocal FT 权重能否成功推理、音质与耗时均未验证。
- 其余三个模型仅保留下载管理，未适配推理。

## 云端构建
1. 解压整个项目，放进 GitHub 仓库根目录，确保 `.github/workflows/android-debug-apk.yml` 一起上传。
2. GitHub → Actions → `Android debug APK (experimental)` → Run workflow。
3. 检查 Build debug APK 步骤；成功时从 artifacts 下载 `musicline-v3-6-experimental-debug-apk`。
4. 安卓设备安装 debug APK 后，进入 AI 模型页面，先点「检查离线运行环境」，随后下载 HQ3 并用 **10 秒 PCM16 WAV** 做测试。
5. 不要在真实模型推理验证前宣称已完全实现离线分离。

## 保留的限制
- MDX HQ3、Vocal FT 的推理仍是实验性；最多 90 秒 PCM16 WAV。
- 5 个模型首次下载后保存在应用私有目录，卸载应用或清除数据会删除模型。
- 视频转音频等模块仍需要实际 Android WebView 兼容测试。
