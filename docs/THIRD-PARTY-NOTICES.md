# Third-party notices

Electron and Chromium notices are included beside the application executable (`LICENSE`, `LICENSES.chromium.html`). React, React DOM, Lucide and Radix UI are included in the JavaScript application and retain their original licenses in the dependency sources.

The application redistributes standalone 7-Zip 21.07 `7za.exe` from `7zip-bin` 5.2.0 for bootstrapping downloaded archives. 7-Zip is Copyright (C) Igor Pavlov and distributed under GNU LGPL, with portions under BSD and the unRAR restriction where applicable. License information: https://www.7-zip.org/license.txt ; corresponding source: https://github.com/ip7z/7zip/tree/21.07 . Included license files are in `resources/app/assets/`. The wrapper package `7zip-bin` uses the MIT license, included as `7zip-bin-LICENSE.txt`.

FFmpeg, ffprobe and NVEncC are downloaded separately at the user's request and are not included in this application ZIP. Their downloaded release directories retain upstream runtime files and any supplied notices. Upstream license/source references: https://ffmpeg.org/legal.html ; https://www.gyan.dev/ffmpeg/builds/ ; https://github.com/rigaya/NVEnc . NVIDIA SDK binaries included by NVEncC are subject to NVIDIA's SDK licenses. This app does not redistribute NVIDIA model packages independently.

The ArtCNN upscaling shaders `ArtCNN_C4F16.glsl` and `ArtCNN_C4F32.glsl` from https://github.com/Artoriuz/ArtCNN is included unmodified in `resources/app/assets/shaders/`. It is Copyright (c) 2024 Joao Chrisostomo, Kacper Michajłow and distributed under the MIT license; the full license text is kept at the top of the shader file. FFmpeg runs it through libplacebo.
