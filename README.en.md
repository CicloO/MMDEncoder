# MMDEncoder

**English** | [简体中文](README.md) | [日本語](README.ja.md)

A portable Windows video encoder for MMD creators: batch-encode rendered videos, handle alpha channels, AI / RTX upscaling and frame generation, lossless trimming, and export finished videos straight from MMD as a video encoder.

Project page: <https://github.com/CicloO/MMDEncoder>

## Features

- **Batch encoding**: H.264 / HEVC / AV1 / VP9 / ProRes in MP4 / MKV / MOV / WebM; software encoding, NVENC, NVEncC, Intel QSV, AMD AMF.
- **Presets**: built-in presets for uploading (Default 4K / 1080p, one hardware and one software each) and for editing (ProRes 4444, H.264 + mask, ProRes 422 HQ). Personal presets can be saved, imported, exported and reordered by dragging.
- **Alpha channel**: keep alpha, split it into a black-and-white mask, export the mask only, or composite onto a green screen.
- **Upscaling and frame generation**: ArtCNN AI upscaling (any GPU with Vulkan), RTX VSR upscaling, RTX frame generation.
- **Lossless trim**: cut segments and join them end to end without re-encoding the video; seek by frame number, time or MMD frame number.
- **MMD export plugin**: choose "MMDEncoder" in MMD's AVI output to export a finished video with audio using a preset, instead of a huge AVI.
- **Audio and video tools**: extract, remove or replace audio tracks, with optional Hi-Res audio.
- **PNG sequences**: encode consecutively numbered PNGs as a video, with transparency.
- **Safe output**: never overwrites the source or existing outputs; a failed hardware encode can be retried with software encoding; the command actually run can be copied.
- **Interface**: English / 简体中文 / 日本語, optionally following the Windows display language; Day / Night themes with a Neon Cyan or Cobalt Blue accent color.

## Installation

Requires Windows 10 / 11 x64.

1. Download `MMDEncoder-<version>-win-x64.zip` from [Releases](https://github.com/CicloO/MMDEncoder/releases), extract it anywhere and run `MMDEncoder.exe`.
2. On first use, open "Encoding engines" and click "Download and install the latest tools", or click "Install from archive" to choose a ZIP / 7z tool package you already have. After that it works offline.

The encoding tools ([FFmpeg / ffprobe](https://www.gyan.dev/ffmpeg/builds/), [NVEncC](https://github.com/rigaya/NVEnc/releases)) are not bundled. They are installed to `%LOCALAPPDATA%\MMDEncoder\tools` by default without administrator rights; you can change the location or check for updates in "Encoding engines". A local FFmpeg package must contain both `ffmpeg.exe` and `ffprobe.exe`; an NVEncC package must contain `NVEncC.exe` or `NVEncC64.exe`.

**Software updates**: open "About & Language" in the top bar. MMDEncoder checks GitHub Releases at startup; when a new version is available, click "Download and update". The download is verified with SHA-256 before the program files are replaced; the `data` folder (settings, personal presets, logs) is left untouched, and a failed update is rolled back automatically. If a built-in preset you edited has changed in the new version, you will be asked whether to overwrite it with the new version or save yours as a personal preset. You can also download the new version manually and copy the old `data` folder into it.

## Usage

### Encode

Audio fades of off, 0.5, 1 or 2 seconds are available on the Audio tab.

Add videos (drag and drop works), choose a preset, check "Expected result" at the bottom, then start encoding. Output goes to an `Encoded` subfolder next to the source by default; duplicate names are numbered automatically.

- The queue can be reordered by dragging; finished or cancelled items can be exported again.
- When settings are incompatible, the bar at the bottom offers a one-click fix that changes only the settings involved.
- **PNG sequences**: drag in the folder holding the sequence, or choose any PNG in it. File names must end in consecutive numbers (for example `dance_0001.png`); missing frames are reported. Set the sequence frame rate under "Current source" (default 30).
- **Edit-friendly** (Advanced tab): one keyframe per second for easier lossless trimming later; files are about 2%–5% larger.
- **Hi-Res audio** (Audio tab, FLAC / PCM): 24-bit, doubling the sample rate when it is below 48 kHz.
- **Audio replacement**: click ♪ next to a video in the queue, or select a video and drag in an audio file; dragging in again replaces the selected item's current audio. Output follows the video's length. Right-click ♪ to cancel the replacement and right-click the waveform button to cancel alignment (Shift+F10 on the keyboard). Automatic alignment is on by default and can be turned off in "About → Settings"; existing offsets are kept and manual alignment still works.

### Alpha channel

On the Alpha tab you can choose:

- **Remove alpha**: transparent areas are output with their original pixel colors.
- **Keep alpha**: ProRes 4444, VP9 (WebM / MKV) or NVEncC HEVC only.
- **Separate alpha**: a color video plus a lossless black-and-white `_alpha` mask with the same name; works with any format.
- **B/W mask only**: exports only the `_alpha` mask.
- **Composite onto green screen**: fills transparent areas with #00FF00.

| Format      | Reads transparency                                   | Does not read transparency                           |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------- |
| ProRes 4444 | After Effects, Premiere, DaVinci, Final Cut          | Practically none                                     |
| VP9 (WebM)  | Chrome, Firefox, OBS browser source                  | After Effects, Premiere                              |
| HEVC Alpha  | macOS system decoder, Safari, Final Cut / AE for Mac | After Effects / Premiere for Windows, system players |

For post-production on Windows, choose ProRes 4444 (built-in preset "Keep Alpha · ProRes 4444") or "Separate alpha". If keeping alpha fails, transparency is never silently dropped.

### Enhance

**Upscaler** (set the target size with "Output resolution" on the Quality tab):

- **Lanczos** (default): regular scaling; fast, slightly soft.
- **ArtCNN** (recommended): AI upscaling with crisper lines that keeps the original grain. Runs on the GPU (NVIDIA / AMD / Intel, Vulkan required) and works with any encoder. It is a 2× model and works best for 1080p → 4K; other sizes are upscaled 2× and then scaled to the target. AI is used only when both width and height are enlarged by more than 1.3×; otherwise Lanczos is used automatically. 1080p → 4K runs at about 80% of Lanczos speed on the development machine. **Not recommended for footage with alpha**: when keeping alpha it is only about a third of Lanczos speed. Models: C4F16 (default, recommended) or C4F32; quality is nearly identical in tests and C4F32 is about 30%–40% slower.
- **RTX VSR**: NVIDIA upscaling at 1–4×; the size is set by the VSR scale.

**RTX VSR / VFG frame generation** works only with the NVEncC encoder; after choosing it, click "Verify RTX settings on this computer" first. VFG frame generation (2–8×) needs an RTX 40 / 50 GPU and the NVIDIA VFX runtime and models. Neither can be combined with keeping alpha or a separate mask yet.

VSR "QualityLevel": for clean renders such as MMD, use **4** (scale 2) for upscaling; if outlines get white halos or look over-sharpened, lower the strength from 1 to 0.5–0.7. 8–11 denoise, 12–15 deblur, 16–19 add detail (these three keep the original size), and 21 / 23 repair live-stream compression, which MMD rarely needs.

### Lossless Trim

Audio fade-in and fade-out at the start and end of the result are supported; joins between segments are not faded.

Cut one or more videos into segments and join them end to end. Video packets are copied as is, so quality is unchanged.

1. Drag in videos. Click the copy button to cut another segment from the same file.
2. Drag the slider or use ←/→ to step frame by frame, ↑/↓ to jump to the previous / next cuttable position, and I / O to set the in / out points. With smart cut off, dragging the slider snaps to the nearest cuttable position. You can also type a frame number or time, or check "Enter MMD frame numbers".
3. Choose the audio mode and click "Export". The output is named "<first segment name>_trimmed".

- **Cut points**: H.264 / HEVC can only be cut at IDR frames (about once per second with Edit-friendly on); ProRes and UtVideo can be cut at any frame. Entered positions snap to the nearest cuttable position. Open-GOP, VP9 / AV1 and variable frame rate (VFR) videos are not supported.
- **MMD frame numbers**: files exported by MMD carry a frame range such as `_0400-0600f` in the name, and the start frame is detected when they are added; for other files you can enter it manually.
- **Smart cut** (off by default): cuts at exactly the entered frames, re-encoding a few frames near each cut with the source's parameters (those frames are lossy). Requires H.264 / HEVC exported by MMDEncoder 1.5.0 or later.
- **Audio**: keep the original audio (cut at the sample and re-encoded), replace it with external audio, or drop audio; the total length always matches the video.
- When joining different files, their encoding parameters must match exactly; otherwise the differences are listed and nothing is exported.

### MMD Export plugin

Options here take precedence over the preset. After upgrading from 1.6.1, update the plugin.

1. Click "MMD Export" at the top right, then "Install into MMD" (registered for the current Windows user only, no administrator needed; restart MMD if it is open).
2. Choose an export preset; you can click "Test encode" first.
3. In MMD, go to File → AVI output, choose "MMDEncoder" as the video codec and export as usual.

The finished video is saved next to the AVI path with the same name (existing files are not overwritten); after rendering, audio is muxed in automatically and the placeholder AVI is deleted. You can also click "詳細設定" (settings) in MMD to change the preset and options; both sides stay in sync.

"Test encode" in "詳細設定" uses the preset and options currently shown in that window and shows the result when it succeeds or fails. Testing does not save the options: click "OK" to save, or "Cancel" to keep the previous settings.

- **Audio**: exports starting at frame 0 use the AVI's audio; exports starting at another frame automatically cut the matching part of the project's (.pmm) WAV. The project must have been saved first.
- **Use MMD's resolution and frame rate** (on by default): uses the size and frame rate set in MMD; everything else follows the preset.
- **Alpha mask**: don't export / export alongside / export only; overrides the preset's own setting.
- **Frame range suffix** (on by default): adds `_0400-0600f` to the file name so lossless trimming can seek by MMD frame number.
- **Unexpected interruption**: if MMD crashes or is closed, the exported part is kept; next time MMDEncoder opens you can finish or delete it.
- **NVEncC / RTX**: NVEncC presets are supported. To use the preset's resolution, frame rate or RTX upscaling / frame generation, turn off "Use MMD's resolution and frame rate"; while it is on, output still follows MMD's size and frame rate. RTX GPU, runtime and alpha requirements are the same as on the Encode page.
- 64-bit MMD only. The plugin is installed to `%LOCALAPPDATA%\MMDEncoder\mmd-plugin` and does not touch the MMD folder; if you move the MMDEncoder folder, just open it once again. Logs can be opened from "MMD Export".

### Extract & Merge

Audio fades are supported, except when copying the original track.

Batch-export audio (WAV / FLAC / AAC / MP3 / Opus, or copy the original track), remove audio tracks, or replace them with external audio, without re-encoding the video. Output is MP4 or MKV (MKV is used automatically when the audio does not fit in MP4). AAC / MP3 / Opus follow the source bitrate by default. WAV / FLAC can use Hi-Res (24-bit, doubling the sample rate when it is below 48 kHz; upsampling does not improve sound quality).

## Built-in presets

| Preset                         | Encoding                          | Resolution            | Use                                          |
| ------------------------------ | --------------------------------- | --------------------- | -------------------------------------------- |
| Default 4K / 1080p · Hardware  | H.264 NVENC p4, CQ 29, AAC 320k   | Long side 3840 / 1920 | Uploading to Bilibili, Douyin, YouTube, etc. |
| Default 4K / 1080p · Software  | x264 medium, CRF 21, AAC 320k     | Long side 3840 / 1920 | Same, without an NVIDIA GPU                  |
| Keep Alpha · ProRes 4444       | ProRes 4444, quant 12, PCM, MOV   | Source                | Transparency read directly by AE / PR        |
| Separate Alpha · H.264 MP4     | H.264 NVENC CQ 19 + `_alpha` mask | Source                | Smallest transparent editing source          |
| Editing Source · ProRes 422 HQ | ProRes 422 HQ, quant 12, PCM, MOV | Source                | Editing source without transparency          |

"Long side" scaling detects landscape and portrait automatically (1920×1080 → 3840×2160, 1080×1920 → 2160×3840). Built-in presets can be renamed, updated, hidden and restored. The reasoning behind the parameters is in [docs/平台上传预设.md](docs/平台上传预设.md), and speed and quality measurements are in [docs/编码器实测对比.md](docs/编码器实测对比.md) (both in Chinese).

## Data locations

| Contents                         | Location                                           |
| -------------------------------- | -------------------------------------------------- |
| Settings, personal presets, logs | `data` in the program folder (kept across updates) |
| Encoding tools                   | `%LOCALAPPDATA%\MMDEncoder\tools`                  |
| MMD export plugin                | `%LOCALAPPDATA%\MMDEncoder\mmd-plugin`             |

## Building from source

Requires Node.js 22+, pnpm and Windows x64.

```powershell
pnpm install
pnpm build             # type-check and build the UI
pnpm start             # run the development build
mmd-plugin\build.cmd   # build the MMD export plugin (needs VS 2022 C++ Build Tools)
pnpm package           # package the portable build
node scripts/zip-portable.mjs
```

The zip script produces the full package `MMDEncoder-x.y.z-win-x64.zip`, the app package `MMDEncoder-x.y.z-app.zip`, a `.sha256` for each and the `MMDEncoder-x.y.z-update.json` manifest; it unpacks both packages to check that their `resources/app` is identical. Existing files of the same version require an explicit `--replace`. For isolated acceptance runs, set `MMD_PACKAGE_DEST` to a new portable folder and `MMD_ARCHIVE_DEST` to a separate archive folder.

When the Electron version is unchanged, automatic updates download only the app package; if the runtime does not match, the manifest is missing or the app package fails verification, the full package is used. The app package replaces only `resources/app`, the full package replaces the program folder; both keep `data`, roll back on failure and log to `data/logs/update.log`.

Tests (`MMD_TEST_TOOLS_ROOT` points to the encoding tools folder):

```powershell
node --test tests/*.test.cjs     # unit tests and real-engine tests
node tests/desktop.mjs           # desktop workflows
node tests/desktop-tools.mjs     # tool installation and settings pages
node tests/desktop-recovery.mjs  # error recovery and restart
node mmd-plugin/tests/e2e.mjs    # MMD export plugin
```

Code layout: `backend/` (encoding commands, tools, job service), `desktop/` (Electron main process), `src/` (React UI), `mmd-plugin/` (C++ DMO encoder), `tests/`, `scripts/`, `assets/` (icons, 7-Zip, ArtCNN shaders), `docs/` (changelog, third-party notices, measurements).

## License

Copyright (c) 2026 CicloO. This project is released under the [Mozilla Public License 2.0](LICENSE): you may freely use, modify and distribute it, including in closed-source or commercial software; if you distribute modified source files of this project, those files must remain available under MPL 2.0. The full license text in the release package is `LICENSE-MMDEncoder.txt` (the `LICENSE` in the same folder belongs to Electron). Versions 1.4.3 and earlier were released under the MIT License.

FFmpeg, NVEncC and other encoding tools are downloaded separately by the user and follow their own licenses; bundled third-party components are listed in [THIRD-PARTY-NOTICES](docs/THIRD-PARTY-NOTICES.md), and version changes are in the [release notes](https://github.com/CicloO/MMDEncoder/releases).

This project draws on the encoding settings of [XPRAMT/MMD2FFMPEG](https://github.com/XPRAMT/MMD2FFMPEG).

## Author

Author: CicloO　Collaborators: Claude, ChatGPT, DeepSeek
