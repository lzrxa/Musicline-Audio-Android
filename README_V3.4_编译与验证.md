# Musicline Offline V3.4 Alpha — 安卓构建准备与真实模型验证

## 完成内容
- 五模型的按需下载和应用内持久存储继续保留；Inst HQ3 / Vocal FT 实验性推理入口保留。
- 选择音频限制为 WAV；本阶段引擎只支持 PCM16、单/双声道、最长 90 秒。
- 新任务启动时清理旧 ZIP，出错时删除失败产物，导出完毕/取消后清理临时 ZIP。
- 写完双轨 ZIP 后逐个读取并检查每个音轨的大小和 CRC，避免损坏 ZIP 被当作成功结果。
- 添加 GitHub Actions 的 `workflow_dispatch` 手动触发构建配置，使用 Java 17 / Android SDK 35 / Gradle 8.10.2 生成**调试版 APK**。未经本地实际 Android 编译验证。

## 完整验证还缺什么
1. 真实 `UVR-MDX-NET-Inst_HQ_3.onnx` 权重（未随包提供），获取后运行 `python tests/probe_real_onnx.py 模型文件 --run --sha256 317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc`。
2. Android Studio 或 GitHub Actions 真实构建结果。请阅读 Action 日志，若 Gradle 依赖或 API 不兼容需要再修正。
3. 真实安卓手机 10 秒音乐和 90 秒音频的推理/导出/内存测试。
4. 另外三种模型的不同参数适配；当前仅管理，不提供已验证的分离功能。

## 构建路径
- 本地 Android Studio：打开工程根目录，安装 Android SDK 35，同步 Gradle，选择 Build APK(s)。
- GitHub Actions：把完整目录上传至你可控的私有 GitHub 仓库，在 Actions 中运行 `Android debug APK (experimental)`，成功后从 Artifact 下载测试 APK。
- Debug APK 会用自动调试证书签名，不能当作稳定发布版本；后续要保留应用数据并升级必须保持相同签名，最终应自行持有发布签名密钥。
- 手机第一次下载模型需要联网，模型下载成功保存在 APP 私有目录，正常重启后保留。卸载应用/清除应用数据会删除模型。

## 当前环境验证边界
源码和数学参考测试不能证明真实人声分离效果。当前执行环境缺 Android SDK 且不可连接 Hugging Face，故没有编译 APK 或进行真实 ONNX 推理。请勿将本工程称作已验收产品。
