# Musicline 离线音频工坊 V3.0 Alpha — ONNX 分离引擎实验阶段

> 交付物是 Android Studio **源码工程**，不是已经编译并通过真机验证的 APK。

## 本阶段新增

- Android 端加入 `com.microsoft.onnxruntime:onnxruntime-android:1.22.0` 和 `com.github.wendykierp:JTransforms:3.1` 依赖（首次 Android Studio 构建需联网下载依赖；安装后推理不需联网）。
- 新增原生 `MdxEngine.java`：本机 PCM16 WAV 解码、单/双声道处理、44.1 kHz 重采样、周期 Hann 窗、STFT、ONNX 推理、iSTFT、分段重叠合成与双轨 WAV 输出。
- 在 AI 模型页新增“选择 WAV 并开始离线分离”，通过安卓系统文件选择器导入音频，不上传远程服务器。
- MDX Inst HQ3（默认伴奏）与 Vocal FT（默认人声）可尝试实验性推理，导出结果为包含两条 WAV 音轨的 ZIP。
- 保留 V2 的五模型首次下载、持久保存、校验、删除和本地导入。Kim Vocal 2、MDX Karaoke、MDX Main 可下载但尚未适配推理参数。
- 支持取消请求，分段结束后检查取消状态。

## 重要限制（务必阅读）

1. **尚未通过 Android SDK 编译和真实手机验证**；不能声称已可直接安装或已达到商业质量，也不能保证 MDX 分离输出的质量、响度或稳定性。
2. 测试版仅接受 **PCM 16-bit WAV**，标准 RIFF/WAVE，最多约 90 秒且不超过 60 MB。MP3/M4A/视频需先使用 App 的其他转换工具导出 WAV。
3. 只有 Inst HQ3 和 Vocal FT 具有已核实的频谱参数 `n_fft=6144,hop=1024,dim_f=3072,dim_t=256`；其他三款模型尚需逐一核实模型架构、stem 和补偿参数。
4. 现阶段使用 CPU ONNX Runtime，内存可能较高，低 RAM 手机可能崩溃；本机的模型授权、性能与音乐质量仍需测试。
5. 源码和 APK 尚**未内置任何 ONNX 权重**：模型需要首次下载或从手机本地导入。下载后位于 App 私有文件目录，日后可断网运行；卸载/清除数据会删除模型。
6. 目前模型下载器只有 HQ3 有预置的可信 SHA-256；其余模型使用首次下载后的本机哈希校验，不能替代仓库发布者签名与授权审查。
7. 本版本原生 MDX 频谱前后处理属于新开发实验代码，尚未与原始 UVR 做数值一致性对照，包括跨分段边缘、补偿系数和重采样品质；正式发布前必须核验。

## 编译与使用

1. Android Studio 打开根目录，配置 JDK 17、Android SDK Platform 35、Android Gradle Plugin（根目录 `build.gradle`）。首次构建联网下载 Gradle 依赖。
2. 点击 Run 安装到设备或 Build APK。包名 `cn.musicline.audiooffline`，升级时保持原签名，模型可保留。
3. AI 模型页选择 MDX Inst HQ3 或 Vocal FT，首次下载模型（也可导入 `.onnx`），确认显示已下载。
4. 使用上方工具将歌曲转换成 16-bit WAV，建议先截取 10 秒进行验证。
5. 点击“选择 WAV 并开始离线分离”，等待原生进度提示，选择位置保存双轨 WAV ZIP。成功后关闭网络可复测。

## 本次验证

- `MdxEngine.java` 在模拟 ONNX/JTransforms API 的占位编译环境下通过 Java 静态编译；这是**语法验证，非真实 Android Gradle 编译**。
- WAV PCM16 44.1 kHz 立体声写入/读回的 Java 小型往返测试通过。
- UI 的 JavaScript 文件通过 `node --check`。
- 未能执行真实 ONNX 推理、Android APK 编译、手机端/飞行模式的端到端测试。

## 回退

使用 V2.0 原工程备份，不要清除现有 app 数据；如果需要回滚，使用相同包名及签名部署旧版代码。


## V3.1 修订与风险说明
- 修复连续点击导致的重复分离任务；取消选择文件后释放任务锁。
- WAV 数据块读取支持 InputStream 短读取，并拒绝不完整的 PCM16 数据。
- ISTFT 归一化数组由双声道共享，节省一小部分内存；模型输出 NaN/Inf 时主动中止。
- `inferenceReady` 只表示本地存在可尝试推理的模型，**不代表模型已经通过真机实测**。
- 当前只接受最多 90 秒 PCM16 WAV；视频转音频和其他音频编辑功能仍需设备实测。
- 核心分离的 MDX STFT 兼容性、模型 ONNX I/O、音质均需要真实权重文件和安卓真机验证。
- 如需安装 APK，请在联网且配置 Android SDK 的机器上运行 Gradle 构建；本包是源码，不是 APK。
