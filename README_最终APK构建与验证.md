# Musicline Audio 4.0 RC1 — APK 构建交付工程

此包**不是 APK**。它包含完整 Android Studio 工程、五模型管理、HQ3 / Vocal FT 实验性推理与可执行的构建和 APK 验包脚本。

## 最直接的构建方式

1. 将本 ZIP 解压后的**所有文件（包含隐藏的 `.github` 文件夹）**上传到 GitHub 仓库根目录。
2. 进入仓库 Actions → `Musicline Android APK Build and Verify` → Run workflow。
3. 构建成功后下载 Artifacts → `musicline-audio-v4-debug-apk`，得到真正的 `app-debug.apk` 及 SHA-256 校验文件。
4. Android Studio 构建可使用 `Build > Build APK(s)`，本地 Linux/Mac 可执行 `tools/build_apk.sh`。

## 必须完成的验收

- 安装 APK、断网打开首页，导入视频导出 MP3/WAV。
- 首次联网下载 MDX Inst HQ3，确认关闭/重启 APP 后本地模型仍存在。
- 断网执行 HQ3 10 秒自检，检查生成音轨并听音确认。
- Vocal FT 再做相同测试；其余三模型目前仍**未实现推理适配**，不可宣称五模型均可分离。
- 真实歌曲测试、90 秒长音频内存测试、后台切换、系统文件导出等仍需真机验证。

## 构建环境说明

当前运行环境没有 Android SDK/Gradle，也不能联网下载安装。工程中的 Gradle 依赖必须在有网络的构建环境首次获取。模型 ONNX 权重**未包含在安装包里**，需要首次下载或本地导入。

## 安全与兼容

- Debug APK 由测试密钥签名，不是正式上架的发布版本；正式发布需自行保管密钥并进行 release 签名。
- 本版版本标识为 `4.0.0-rc1`，不是已验证的正式版。
- 模型保存在 APP 私有存储，正常签名一致的升级通常保留数据；卸载/清除数据会清理模型。
