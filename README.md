# MMD Encoder

> [!NOTE]
> 这是作者的个人项目，不做宣传，也不承诺维护和支持。如有反馈，请单独告知作者。使用条款以 [MIT 许可证](LICENSE) 为准。

面向 MMD 创作者的 Windows 便携视频压制工具。批量压制渲染视频，支持透明通道、各平台上传预设、NVIDIA 硬件编码与 RTX 视频增强。

项目地址：<https://github.com/CicloO/MMDEncoder>

## 功能

- **批量压制**：H.264 / HEVC / AV1 / VP9 / ProRes，MP4 / MKV / MOV / WebM 容器；软件编码、NVENC、NVEncC，以及 Intel QSV / AMD AMF 硬件编码。
- **平台上传预设**：内置 YouTube、B站、抖音 / TikTok、X 的上传预设，前四个平台各有硬件（NVENC）和软件（x264）两个版本；也可以保存、导入、导出个人预设。
- **检查更新**：启动时自动查询 GitHub Releases，有新版本时提示。
- **透明通道**：保留 Alpha（ProRes 4444、VP9、NVEncC HEVC），或转为 RGB 并另外输出灰度遮罩。
- **分辨率与帧率**：自定义输出尺寸（默认保持各视频自身的宽高比），以及帧率转换。
- **RTX 增强**：RTX Video Super Resolution 放大（1–4 倍），RTX 插帧（2–8 倍）。
- **音视频提取与合并**：单独导出音频（WAV / FLAC / AAC / Opus），去除音轨，替换音轨。
- **安全输出**：默认输出到源目录的 `Encoded` 子目录，不覆盖源文件和已有输出；硬件编码失败时可以改用软件编码重试；可复制实际执行的命令。

## 系统要求

- Windows 10 / 11 x64
- 首次使用需要联网下载编码工具，之后可以离线使用
- 硬件编码需要相应显卡；RTX 插帧需要 Ada（RTX 40）或 Blackwell（RTX 50）显卡、NVIDIA VFX 运行库和模型

## 安装与使用

1. 从 [Releases](https://github.com/CicloO/MMDEncoder/releases) 下载 `MMDEncoder-<版本>-win-x64.zip`，解压到任意目录。
2. 运行 `MMD Encoder.exe`。
3. 第一次使用时，在“编码引擎”中点击“下载并安装最新工具”。
4. 添加视频，选择预设，检查预计结果后开始压制。

软件包本身不包含 FFmpeg、ffprobe 和 NVEncC，它们在第 3 步下载：

- FFmpeg / ffprobe：[Gyan full builds](https://www.gyan.dev/ffmpeg/builds/)
- NVEncC：[rigaya/NVEnc Releases](https://github.com/rigaya/NVEnc/releases)

工具默认安装在 `%LOCALAPPDATA%\MMDEncoder\tools`，不需要管理员权限；也可以在“编码引擎”里点“更改位置”换到别的文件夹，已安装的工具会一起移过去（选择已装有本软件工具的文件夹则直接使用），“恢复默认位置”可改回。选择的位置记在软件目录的 `data` 里。之后可以离线使用，需要时在“编码引擎”中手动检查更新。更新时会先校验并验证新版本，失败则保留旧版本；正在压制时不能更新。

### 软件更新

软件启动时会查询一次本项目的 [GitHub Releases](https://github.com/CicloO/MMDEncoder/releases)，有新版本时给出提示；也可以在右上角“设置与引擎”里点“检查更新”。软件不会自动下载或替换自己：点“打开下载页”，下载新的压缩包解压即可。设置、个人预设和日志在软件目录的 `data` 里，想保留就把旧版的 `data` 复制到新版目录。

## 使用说明

### 视频压制

添加视频，选择个人预设或平台预设，检查预计结果后开始压制。输出默认位于源目录的 `Encoded` 子目录。

已完成或已取消的视频，可以点条目右侧 × 左边的刷新按钮“重新导出”：它会回到待压制状态，下次开始压制时按当前设置导出；已有的输出文件不会被覆盖，新文件自动编号，如 `xxx (2).mp4`。

设置不兼容时，底部提示条会给出可以一键应用的修正方案，只调整相关设置，不改动帧率、输出目录等其他选择。

### 透明通道

可以保留 Alpha 的格式：

- ProRes 4444（MOV / MKV，10-bit，4:4:4）
- VP9（WebM / MKV，8-bit，4:2:0）
- NVEncC HEVC（MP4 / MOV / MKV，8-bit，4:2:0，需本机试编码通过）

HEVC 的 Alpha 存在辅助层里，Windows 自带播放器可能显示不出透明效果。保留 Alpha 失败时不会改用软件编码而悄悄丢掉透明度。

### RTX 增强

只能配合 NVEncC 使用，选好 VSR / VFG 后要先点“验证本机 RTX 设置”，通过后才能压制。

- **VSR 超分辨率**：放大 1–4 倍，或在原尺寸下去噪、去模糊、补细节。档位怎么选见下方 [RTX 视频增强（VSR）怎么选](#rtx-视频增强vsr怎么选)。
- **VFG 插帧**：2–8 倍，在源帧率基础上乘倍率。需要 Windows、Ada / Blackwell 显卡、NVEncC 9.36+、NVIDIA VFX 运行库和模型。
- RTX 增强暂时不能和保留 Alpha、独立遮罩一起使用。

### 音视频提取与合并

- 只导出音频（WAV / FLAC / AAC / Opus，或直接复制原音轨）。
- 去除视频的音轨。
- 用独立音频替换原音轨。默认按较短的一条流结束，可以取消这个选项。

和视频压制页一样是批量队列：把多个文件拖进窗口或点“添加文件”，开始处理后逐个导出，每个文件显示自己的状态。合并时，拖入的音频会配给选中的视频（或第一个还没有音频的视频），也可以点条目上的音符按钮单独选择。

输出文件名自动生成，位置可选：**与源文件同目录**（默认）、源目录下的 `Encoded` 子文件夹，或自定义文件夹。已有文件不覆盖、自动编号。已完成、已取消或失败的条目可以点刷新按钮“重新导出”，也可以“清除已完成”。

视频取第一条视频流复制到 MKV，音频取第一条音频流，源文件保持不变。

### 文件详情

直接用 ffprobe 读取源文件和实际输出文件的参数，转换前、后左右并排对比。输出还没生成时显示“尚未生成文件”，不会推测转换后的参数。

## 平台上传预设

内置预设针对各平台的二次压制做了优化：H.264 8-bit 4:2:0 BT.709，并把 1080p 渲染放大到 4K 以进入平台的高码率档位。除 X 外，每个平台都有两个版本，两者码率相近：

- **· 硬件**：NVIDIA NVENC（p4，恒定质量 CQ），需要 NVIDIA 显卡，几乎不占 CPU。实测 p4 与 p7 画质相同、速度约快一倍多（X 1080p 为固定码率，保留 p7）。
- **· 软件**：x264（medium，恒定质量 CRF），任何电脑都能用，速度取决于 CPU。

| 预设             | 分辨率          | 硬件    | 软件   |
| ---------------- | --------------- | ------- | ------ |
| YouTube 4K       | 宽 3840         | CQ 27   | CRF 19 |
| B站 4K           | 宽 3840         | CQ 29   | CRF 21 |
| B站 1080P60      | 宽 1920         | CQ 29   | CRF 21 |
| 抖音 / TikTok 4K | 高 3840（竖屏） | CQ 29   | CRF 21 |
| X 1080p          | 宽 1920         | 20 Mbps | —      |

> [!NOTE]
> 除 YouTube 外，各平台没有公开的官方上传规格，这些参数来自社区经验，尚未经过全面的实际上传验证。参数依据和取舍见 [docs/平台上传预设.md](docs/平台上传预设.md)，硬件 / 软件编码的速度与画质实测见 [docs/编码器实测对比.md](docs/编码器实测对比.md)。

## RTX 视频增强（VSR）怎么选

VSR 在“RTX 增强”页设置，只能配合 NVEncC 使用，开始前要先点“验证本机 RTX 设置”。“NVIDIA QualityLevel”每 4 档为一组，组内从低到高是 Low / Medium / High / Ultra，数字越大效果越好，也越占显卡：

| 档位    | 作用                   | 适合的素材                           |
| ------- | ---------------------- | ------------------------------------ |
| 0       | 双三次放大（对照基线） | 只用来对比效果                       |
| **1–4** | VSR 放大，4 最好       | **干净的渲染画面放大，MMD 属于这类** |
| 8–11    | 去噪，保持原尺寸       | 有噪点的实拍、低光素材               |
| 12–15   | 去模糊，保持原尺寸     | 被压缩糊掉的素材                     |
| 16–19   | 补细节，保持原尺寸     | 原尺寸输出，只想让画面更锐           |
| 21 / 23 | 修复直播流压缩伪影     | 低码率直播录像                       |

MMD 渲染输出本身很干净，建议：

- **放大（如 1080p → 4K 上传）**：选 **4**，倍率 2。强度先用 1；如果线条边缘出现白边或过锐，降到 0.5–0.7。
- **不放大**：可以试 16–19，但要先和原片对比，看描边是否过锐。
- **去噪、去模糊、直播档**：MMD 一般用不上，去模糊还可能让描边过锐。

VSR 与普通的自定义分辨率不能同时使用。用平台预设时，如果想改用 VSR 放大，请把输出分辨率改回“源分辨率”，再把 VSR 倍率设为 2。

## 数据位置

| 内容                 | 位置                                        |
| -------------------- | ------------------------------------------- |
| 设置、个人预设、日志 | 软件目录下的 `data`（更新软件时保留此目录） |
| 编码工具             | `%LOCALAPPDATA%\MMDEncoder\tools`           |
| 默认输出             | 源视频所在目录的 `Encoded` 子目录           |

## 从源码构建

需要 Node.js 22+、pnpm 和 Windows x64。

```powershell
pnpm install
pnpm build      # 类型检查并构建界面
pnpm start      # 启动开发版
pnpm package    # 打包便携版
node scripts/zip-portable.mjs
```

开发版从本机安装目录读取编码工具。可以用环境变量 `MMD_ENCODER_TOOLS_ROOT` 指向其他工具目录。

### 测试

```powershell
$env:MMD_TEST_TOOLS_ROOT = "<工具目录>"
node --test tests/*.test.cjs   # 单元测试和真实引擎测试
node tests/desktop.mjs         # 桌面流程测试
node tests/desktop-tools.mjs   # 工具安装流程测试
node tests/rtx-live.cjs        # RTX 实机测试（需要 NVIDIA 显卡）
```

### 目录结构

| 目录       | 内容                                           |
| ---------- | ---------------------------------------------- |
| `backend/` | 编码命令生成、工具安装、任务服务               |
| `desktop/` | Electron 主进程与 IPC                          |
| `src/`     | React 界面                                     |
| `tests/`   | 单元、真实引擎和桌面测试                       |
| `scripts/` | 构建与发行脚本                                 |
| `assets/`  | 图标与 7-Zip 解压器                            |
| `docs/`    | 更新日志、第三方声明、预设依据、编码器实测对比 |

## 第三方组件

见 [THIRD-PARTY-NOTICES](docs/THIRD-PARTY-NOTICES.md) 和 [更新日志](docs/CHANGELOG.md)。

## 参考

本项目参考了 [XPRAMT/MMD2FFMPEG](https://github.com/XPRAMT/MMD2FFMPEG)（MMD 直接输出到 FFmpeg 的插件）的编码设置。

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布。

FFmpeg、ffprobe、NVEncC 等第三方工具不属于本项目，由用户另行下载，遵循各自的许可证，详见 [THIRD-PARTY-NOTICES](docs/THIRD-PARTY-NOTICES.md)。

## 作者

作者：CicloO　协作：Claude、ChatGPT
