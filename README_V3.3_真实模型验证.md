# Musicline Audio Offline V3.3 Alpha — 模型验证工具及导出稳定性

这是 Android Studio 源码工程，不是 APK。**没有附带五个 ONNX 权重**，也未完成真实 ONNX 推理、真实音质、Android APK 构建或手机测试。当前仅 HQ3 / Vocal FT 有实验性推理入口，其他三款只有下载/存储管理。

## 本次改进

- 分离结果 ZIP 先写入 `.partial` 文件，检查两条条目后再发布正式 ZIP；错误时删除未完成的文件，避免把旧 ZIP 当成新结果。
- 双轨 WAV 导出核对预期精确文件长度并拒绝非有限采样值，避免损坏的输出被默默视为成功。
- 新增 `tests/verify_fft_reference.py`，采用 NumPy/Scipy 完成 44.1k/6144 FFT/1024 hop/256 帧/2 段重叠的**无模型**数值回归测试。结果误差仅适用于此合成参考信号。
- 新增 `tests/probe_real_onnx.py`，用户可在电脑下载真实 ONNX 后离线检查 SHA-256、输入输出形状、float32 类型，并用 `--run` 执行一次 CPU 零输入推理。
- 保持五模型选择、本地持久下载、视频转 MP3/WAV 和原有音频编辑器源码不变。

## 验证命令

```bash
python -m pip install numpy scipy onnxruntime
python tests/verify_fft_reference.py
python tests/probe_real_onnx.py /path/to/UVR-MDX-NET-Inst_HQ_3.onnx --run
python tests/verify_stems.py tests/fixture_synthetic_stems.zip
python tests/verify_source.py
```

`--run` 使用合成的全零频谱做模型调用，**不代表伴奏分离效果已通过**。真机应用内请选择 10 秒 PCM16 WAV 进行验证，并使用相同音频与 UVR 桌面版本试听对照。安卓调试仍要求 SDK、Gradle、USB 设备和完整依赖。

## 仍需解决的工作

1. 获得可校验的真实 HQ3、Vocal FT 权重，运行 `probe_real_onnx.py`，记录模型实际输入与输出信息。
2. Android Studio 编译 APK 并在手机上测运行内存/分离速度/双轨音质。当前没有 Android SDK 和真机结果。
3. 根据模型实际规格逐一适配 Kim Vocal 2、MDX Karaoke 与 MDX Main。不能直接假设五个模型都是相同 ONNX 输入规格。
4. 延长超过 90 秒的音频处理时，改为分块读写以避免大内存占用。

**注意**：应用私有目录中的模型会在正常升级时保留，但卸载或清除应用数据会删除。打包前请认真核实所有第三方模型和代码的使用许可。
