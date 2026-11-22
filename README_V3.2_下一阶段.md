# Musicline Audio Offline V3.2 Alpha — 离线 MDX 引擎核验与安全导出

本 ZIP 是 Android Studio **工程源码**，不是 APK，也未内置 ONNX 模型。五模型下载/导入管理仍保留；当前仅对 MDX Inst HQ3 和 Vocal FT 提供实验性本地推理。

## 本轮代码改动

1. 在开始处理音频段之前，读取真实 ONNX Runtime session 的模型 I/O 元数据：必须各有一个输入/输出，形状符合 `[1,4,3072,256]`（允许动态轴）。不匹配则明确报错，不再盲目运行。
2. 取消任务时不再发布一半写完的双轨文件；先写 `.partial`，两轨完整后重命名。失败时清理临时 WAV 文件。
3. Android ZIP 导出前检查文件有效存在及大小。
4. 增加 `tests/verify_stems.py`，用于检查**实际从安卓导出的 ZIP**：两个 WAV、44100 Hz、16-bit、相同时长，且 ZIP 无损坏。
5. 保留原有视频转音频和音频编辑组件，不扩大模型兼容范围，也不更改用户已有模型存储位置。

## 真实模型核验的前提

- HQ3 / Vocal FT 已知频谱配置 `n_fft=6144`、`hop=1024`、`dim_f=3072`、`dim_t=256`，输入通道顺序 `[L_re,L_im,R_re,R_im]`。来源见 `https://huggingface.co/gyoom/UVR-MDX-CoreML`（源模型架构参考）。
- 仍须下载真实模型并验证 ONNX 实际 I/O、音质、分离极性和计算速度；运行环境当前无法联网下载权重，也没有 Android SDK，**无法声称这一版已经跑通真实 HQ3 推理或可以直接安装**。
- 仅读取已下载本地模型，模型仍保存在应用私有 `filesDir/mdx-models`；升级应使用相同包名及签名。

## 如何测试

- `python tests/verify_source.py`：源码状态检查。
- 安卓端在模型页下载 HQ3，导入 10 秒 PCM16 WAV，执行分离，保存双轨 ZIP。
- 用电脑运行 `python tests/verify_stems.py Musicline_MDX_双轨离线分离.zip`，检测导出文件结构（需要 numpy）。
- 音质与正确性：把同一 10 秒原始音频交由 UVR 基准模型处理，进行 SDR/SI-SDR、时长与波形对齐的对比；这一项还没有完成。

## 已知限制

90 秒/60 MB PCM16 WAV 限额、实验性 CPU 推理、无真机测速、无 Android APK 编译；其他三款模型仅下载管理。此次修复不能保证所有安卓设备的 ONNX Runtime 兼容性。

## 编译核验说明

`MdxEngine.java` 已使用补齐输出元数据接口的**编译专用 ONNX 替身**完成 `javac` 编译。`tests/stubs` 仅用于源码检查，不能证明真实 ONNX Runtime 的版本 API 或安卓设备推理可用，也没有打入 APP。正式构建需要 Android SDK、Gradle、真实 `onnxruntime-android` 和 `JTransforms` 依赖。
