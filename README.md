# MMDEncoder

面向 MMD 创作者的 Windows 便携视频压制工具：批量压制渲染视频，处理透明通道，AI / RTX 超分与插帧，无损剪辑，并能作为 MMD 的视频编码器直接导出成片。

项目地址：<https://github.com/CicloO/MMDEncoder>

## 功能

- **批量压制**：H.264 / HEVC / AV1 / VP9 / ProRes，MP4 / MKV / MOV / WebM；软件编码、NVENC、NVEncC、Intel QSV、AMD AMF。
- **预设**：内置上传用（默认 4K / 1080p，硬件与软件各一）和后期素材用（ProRes 4444、H.264 + 遮罩、ProRes 422 HQ）预设；个人预设可保存、导入导出、拖动排序。
- **透明通道**：保留 Alpha、分离成黑白遮罩、只导出遮罩，或合成到绿幕。
- **超分补帧**：ArtCNN AI 放大（支持 Vulkan 的任何显卡）、RTX VSR 超分、RTX 插帧。
- **无损剪辑**：分段裁切、首尾拼接，视频不重新压制；支持帧号、时间和 MMD 帧号定位。
- **MMD 导出插件**：在 MMD 的“AVI 输出”里选“MMDEncoder”，直接按预设导出带音频的成片，不再生成巨大的 AVI。
- **音视频工具**：提取、去除、替换音轨，可选 Hi-Res 音频。
- **PNG 序列**：连续编号的 PNG 当作视频压制，支持透明。
- **安全输出**：不覆盖源文件和已有输出；硬件编码失败可改用软件重试；可复制实际执行的命令。

## 安装

需要 Windows 10 / 11 x64。

1. 从 [Releases](https://github.com/CicloO/MMDEncoder/releases) 下载 `MMDEncoder-<版本>-win-x64.zip`，解压到任意目录，运行 `MMDEncoder.exe`。
2. 第一次使用时在“编码引擎”里点“下载并安装最新工具”。需要联网，之后可以离线使用。

编码工具（[FFmpeg / ffprobe](https://www.gyan.dev/ffmpeg/builds/)、[NVEncC](https://github.com/rigaya/NVEnc/releases)）不随软件附带，默认装在 `%LOCALAPPDATA%\MMDEncoder\tools`，不需要管理员权限；可以在“编码引擎”里更改位置或检查更新。

**软件更新**：在顶栏“关于”中操作。启动时会检查 GitHub Releases，有新版本时点“下载并更新”，校验 SHA-256 后替换程序文件，`data` 文件夹（设置、个人预设、日志）保留不动，失败会自动还原。你改过的内置预设如果在新版里有变化，会询问用新版覆盖还是另存为个人预设。也可以手动下载新版，把旧版的 `data` 复制过去。

## 使用

### 视频压制

音频分页支持关闭、0.5、1、2 秒淡入淡出。

添加视频（可拖入），选择预设，检查底部的“预计结果”后开始压制。默认输出到源目录的 `Encoded` 子目录，重名自动编号。

- 队列可以拖动排序；已完成或已取消的条目可以“重新导出”。
- 设置不兼容时，底部提示条会给出一键修正，只改相关设置。
- **PNG 序列**：拖入装有序列的文件夹，或选其中任意一张 PNG。文件名末尾要有连续编号（如 `dance_0001.png`），缺帧会提示。在“当前素材”里选序列帧率（默认 30）。
- **剪辑友好**（“高级”页）：每秒一个关键帧，方便之后无损剪辑，文件约大 2%~5%。
- **Hi-Res 音频**（“音频”页，FLAC / PCM）：24-bit，低于 48 kHz 时升到 2 倍采样率。
- **替换音频**：点队列里视频旁的 ♪ 选择音频文件，按视频时长截取；在“当前素材”里可以改回原音轨。

### 透明通道

“透明通道”页可以选：

- **移除 Alpha**：透明区域按原像素颜色输出。
- **保留 Alpha**：只能用 ProRes 4444、VP9（WebM / MKV）或 NVEncC HEVC。
- **分离 Alpha**：彩色视频加一个同名 `_alpha` 无损黑白遮罩，任何格式都可以。
- **仅黑白遮罩**：只导出 `_alpha` 遮罩。
- **合成到绿幕**：透明区域填成 #00FF00。

| 格式        | 能读到透明                                      | 读不到透明                                     |
| ----------- | ----------------------------------------------- | ---------------------------------------------- |
| ProRes 4444 | After Effects、Premiere、DaVinci、Final Cut     | 基本没有                                       |
| VP9（WebM） | Chrome、Firefox、OBS 浏览器源                   | After Effects、Premiere                        |
| HEVC Alpha  | macOS 系统解码器、Safari、Mac 版 Final Cut / AE | Windows 版 After Effects、Premiere、系统播放器 |

在 Windows 上做后期，选 ProRes 4444（内置预设“保留 Alpha · ProRes 4444”）或“分离 Alpha”。保留 Alpha 失败时不会悄悄丢掉透明度。

### 超分补帧

**放大算法**（目标尺寸在“画质”页的“输出分辨率”设置）：

- **Lanczos**（默认）：普通缩放，速度快，画面偏软。
- **ArtCNN**（推荐）：AI 放大，线条更清晰，保留原有颗粒质感。在显卡上运行（NVIDIA / AMD / Intel，需要 Vulkan），任何编码器都能用。它是 2 倍放大模型，1080p → 4K 效果最好，其他尺寸先放大 2 倍再缩放到目标；宽、高都要放大超过 1.3 倍才会用到 AI，否则自动改用 Lanczos。1080p → 4K 本机实测约为 Lanczos 速度的 80%。**不建议用于带透明通道的素材**：保留 Alpha 时只有 Lanczos 的三分之一左右。模型可选 C4F16（默认、推荐）或 C4F32，实测画质几乎相同，C4F32 慢约 30%–40%。
- **RTX VSR**：NVIDIA 超分，放大 1–4 倍，由“VSR 倍率”决定尺寸。

**RTX VSR / VFG 插帧**只能配合 NVEncC 编码器，选好后先点“验证本机 RTX 设置”。VFG 插帧（2–8 倍）需要 RTX 40 / 50 显卡和 NVIDIA VFX 运行库与模型。两者暂不能和保留 Alpha、独立遮罩一起用。

VSR 的“QualityLevel”：MMD 这类干净的渲染画面放大选 **4**（倍率 2）；描边出现白边或过锐时把强度从 1 降到 0.5–0.7。8–11 去噪、12–15 去模糊、16–19 补细节（这三组都保持原尺寸），21 / 23 修复直播压缩，MMD 一般用不上。

### 无损剪辑

支持成片首尾音频淡入淡出，片段接缝不淡化。

把一个或多个视频切段、首尾相接，视频逐包复制，画质不变。

1. 拖入视频。同一文件可以点复制按钮再切一段。
2. 拖动滑块或用 ←/→ 逐帧查看，↑/↓ 跳到上一个 / 下一个可切位置，I / O 设入点 / 出点；未开启智能剪切时，拖动滑块会吸附到最近的可切位置；也可以输入帧号、时间，或勾选“按 MMD 帧号输入”。
3. 选择音频方式，点“导出”，输出名为“第一段名_剪辑”。

- **切点**：H.264 / HEVC 只能在 IDR 帧切开（开启“剪辑友好”后约每秒一个），ProRes、UtVideo 每帧都可以。输入位置会吸附到最近的可切位置。开放 GOP、VP9 / AV1、可变帧率（VFR）视频不支持。
- **MMD 帧号**：MMD 导出的文件名带 `_0400-0600f` 这样的帧范围，加入时自动识别起始帧；其他文件可以手动填写。
- **智能剪切**（默认关闭）：按输入的帧精确切开，切点附近几帧用原片参数重新编码（这几帧有损）。需要 MMDEncoder 1.5.0 起导出的 H.264 / HEVC。
- **音频**：保留原音频（按采样点截取后重新编码）、替换为外部音频或不要音频，总长度始终与视频一致。
- 不同文件拼接时，编码参数必须完全一致，否则列出不同之处并且不导出。

### MMD 导出插件

这里的选项都优先于预设。升级 1.5.2 后请更新插件。

1. 点右上角“MMD 导出”→“安装到 MMD”（只为当前 Windows 用户注册，不需要管理员；MMD 开着的话重启 MMD）。
2. 选择导出预设，可以先点“测试编码”。
3. 在 MMD 里 文件 → AVI 输出，视频编码选“MMDEncoder”，照常输出。

成片保存在 AVI 路径旁边、同名（已有文件不覆盖），渲染结束后自动合成音频并删除占位 AVI。也可以在 MMD 里点“詳細設定”改预设和选项，两边同步。

- **音频**：从第 0 帧导出时用 AVI 的音频；从其他帧开始时自动从工程（.pmm）的 WAV 截取对应片段，工程需要先保存过。
- **分辨率和帧率跟随 MMD**（默认开启）：用 MMD 设定的尺寸和帧率，其他按预设。
- **Alpha 遮罩**：不导出 / 同时导出 / 仅导出，优先于预设自带的设置。
- **帧范围后缀**（默认开启）：文件名加 `_0400-0600f`，方便无损剪辑时按 MMD 帧号定位。
- **意外中断**：MMD 崩溃或被关闭时，已导出的部分会保留，下次打开 MMDEncoder 可以补完或删除。
- 只支持 64 位 MMD，暂不支持 NVEncC 预设。插件装在 `%LOCALAPPDATA%\MMDEncoder\mmd-plugin`，不改动 MMD 文件夹；移动了 MMDEncoder 文件夹后重新打开一次即可。日志可在“MMD 导出”里打开。

### 音视频提取与合并

支持音频淡入淡出；复制原音轨时不可用。

批量导出音频（WAV / FLAC / AAC / MP3 / Opus 或复制原音轨）、去除音轨、用外部音频替换音轨，视频不重新压制，输出 MP4 或 MKV（放不进 MP4 时自动改用 MKV）。AAC / MP3 / Opus 默认跟随源码率。WAV / FLAC 可选 Hi-Res（24-bit，低于 48 kHz 时升到 2 倍采样率；升采样不会让音质变好）。

## 内置预设

| 预设                     | 编码                              | 分辨率           | 用途                       |
| ------------------------ | --------------------------------- | ---------------- | -------------------------- |
| 默认 4K / 1080p · 硬件   | H.264 NVENC p4，CQ 29，AAC 320k   | 长边 3840 / 1920 | 上传 B站、抖音、YouTube 等 |
| 默认 4K / 1080p · 软件   | x264 medium，CRF 21，AAC 320k     | 长边 3840 / 1920 | 同上，没有 NVIDIA 显卡时   |
| 保留 Alpha · ProRes 4444 | ProRes 4444，量化 12，PCM，MOV    | 源分辨率         | AE / PR 直接读透明         |
| 分离 Alpha · H.264 MP4   | H.264 NVENC CQ 19 + `_alpha` 遮罩 | 源分辨率         | 文件最小的透明后期素材     |
| 剪辑素材 · ProRes 422 HQ | ProRes 422 HQ，量化 12，PCM，MOV  | 源分辨率         | 不需要透明的后期素材       |

“长边”缩放会自动识别横竖屏（1920×1080 → 3840×2160，1080×1920 → 2160×3840）。内置预设可以改名、更新、隐藏和恢复。参数依据见 [docs/平台上传预设.md](docs/平台上传预设.md)，速度与画质实测见 [docs/编码器实测对比.md](docs/编码器实测对比.md)。

## 数据位置

| 内容                 | 位置                                   |
| -------------------- | -------------------------------------- |
| 设置、个人预设、日志 | 软件目录下的 `data`（更新软件时保留）  |
| 编码工具             | `%LOCALAPPDATA%\MMDEncoder\tools`      |
| MMD 导出插件         | `%LOCALAPPDATA%\MMDEncoder\mmd-plugin` |

## 从源码构建

需要 Node.js 22+、pnpm 和 Windows x64。

```powershell
pnpm install
pnpm build             # 类型检查并构建界面
pnpm start             # 启动开发版
mmd-plugin\build.cmd   # 编译 MMD 导出插件（需要 VS 2022 C++ 生成工具）
pnpm package           # 打包便携版
node scripts/zip-portable.mjs
```

测试（`MMD_TEST_TOOLS_ROOT` 指向编码工具目录）：

```powershell
node --test tests/*.test.cjs     # 单元测试和真实引擎测试
node tests/desktop.mjs           # 桌面流程
node tests/desktop-tools.mjs     # 工具安装与设置页
node tests/desktop-recovery.mjs  # 出错恢复与重启
node mmd-plugin/tests/e2e.mjs    # MMD 导出插件
```

代码结构：`backend/`（编码命令、工具、任务服务）、`desktop/`（Electron 主进程）、`src/`（React 界面）、`mmd-plugin/`（C++ DMO 编码器）、`tests/`、`scripts/`、`assets/`（图标、7-Zip、ArtCNN 着色器）、`docs/`（更新日志、第三方声明、实测）。

## 许可证

Copyright (c) 2026 CicloO。本项目以 [Mozilla Public License 2.0](LICENSE) 发布：可以自由使用、修改和分发，包括用在闭源或商业软件中；修改了本项目的源文件并分发时，这些文件须继续以 MPL 2.0 公开。发行包里的协议全文是 `LICENSE-MMDEncoder.txt`（同目录的 `LICENSE` 是 Electron 的）。1.4.3 及以前的版本以 MIT 许可证发布。

FFmpeg、NVEncC 等编码工具由用户另行下载，遵循各自的许可证；附带的第三方组件见 [THIRD-PARTY-NOTICES](docs/THIRD-PARTY-NOTICES.md)，版本变化见 [更新日志](docs/CHANGELOG.md)。

本项目参考了 [XPRAMT/MMD2FFMPEG](https://github.com/XPRAMT/MMD2FFMPEG) 的编码设置。

## 作者

作者：CicloO　协作：Claude、ChatGPT
