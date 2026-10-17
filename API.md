# Desktop / service contract

`createService({engineDir?,toolsRoot?,dataDir,onUpdate})` returns `invoke(action,payload)`, `getState()` and `dispose()`. `src/types.ts` defines Settings, State and Job. Backend runtime modules use Node built-ins only.

The isolated preload exposes a fixed action allowlist, state events, close requests and local File path conversion. Main verifies sender and main frame. There is no general shell / IPC API. Desktop file dialogs are intentional.

Core actions: state, detect, add/remove/clearCompleted, settings, start/cancel/retry, preview, logs, save/apply/delete/rename/import presets. Settings persist atomically; presets retain global output location. Jobs freeze settings. Existing destinations and source overwrite are refused.

- `checkTools` / `installTools`: official metadata, download, verification and activation. Refuse concurrent tasks/detection/RTX verification. `state.tools` provides phase, byte counts, versions, root and persistent error text.
- `compatibility {settings}` returns `{errors,suggestions:[{id,label,patch}]}`. Only a user click applies the whole patch. Device probes determine available HEVC Alpha alternatives.
- `testEnhancements {settings}` runs a real RTX trial. `state.enhancements` records signature, status and diagnostics; relevant changes invalidate it.
- `details {id}` returns real ffprobe `before`, `after` and `mask` data, or an explicit absent-file message.
- `mediaStart {operation:'audio'|'video'|'merge',input,audioInput?,output,audioFormat:'wav'|'flac'|'aac'|'opus'|'copy',shortest?}` starts an exclusive task. `state.media` carries status, logs, errors and output. `cancel` cancels it. First applicable streams are used. MKV is required for stream-copy video extraction/merge; audio-only uses WAV / FLAC / M4A / Opus / MKA.
- Native `pickMedia` / `pickMediaOutput` return path or null.

Runtime paths: `%LOCALAPPDATA%/MMDEncoder/tools` for downloaded engines; portable `data` for settings, presets/logs. `MMD_ENCODER_TOOLS_ROOT`, `MMD_ENCODER_ENGINES`, `MMD_ENCODER_DATA` inject isolated test locations. Tests use `MMD_TEST_TOOLS_ROOT` for independently installed FFmpeg/NVEncC or `MMD_TEST_ENGINE_DIR` for one development engine directory.
