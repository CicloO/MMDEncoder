# Implementation notes

Current version: 1.2.4. The verified 1.0.2 desktop source was migrated from the earlier delivery without editing that product directory. The repository now owns `backend`, `desktop`, `src`, `assets`, `tests`, `scripts` and `docs` at root.

Encoding commands and validation: `backend/core.cjs`. Process lifecycle, settings, queue, details and media tasks: `backend/service.cjs`. Official release resolution, hash validation, complete archive staging, executable checks and atomic active-version metadata: `backend/tools.cjs`. Standalone 7za bootstraps extraction. Tools are located only from managed installations or an explicit development override.

HEVC Alpha uses FFV1 YUVA444 preparation, NVEncC YUVA420 8-bit straight Alpha and stream-copy muxing. Capability probes inspect the HEVC Alpha Channel Information SEI and bit depth. It cannot silently fall back to software HEVC.

RTX filters require a real trial of the chosen settings, including output dimensions/FPS inspection. Relevant setting or installed-tool changes invalidate the trial. VFG rejects unsupported OS/version/GPU families, Alpha and conflicting FPS settings. Runtime/model failures remain visible.

Media extraction/merge shares process cancellation, exclusive temporary outputs, no-overwrite commit and persistent logs. Details read actual source/output ffprobe JSON. Function pages and settings tabs reuse established primitives/tokens.

Runtime evidence belongs in ignored `verification/`; packages in ignored `release/`. Desktop/GPU tests on this machine require normal Windows execution outside the Codex sandbox: sandboxed Chromium GPU child exits 0xC0000135 and can produce a 0x80000003 fatal window; identical normal execution succeeds. Production GPU acceleration is unchanged.
