# UX contract

Locale zh-CN, local Windows desktop, offline by default. No accounts or uploads.

已迁移文案由 `locales/zh-CN.json` 和 `src/i18n.ts` 管理。业务错误用稳定 code 与参数跨 IPC 传递；迁移后的调用方使用 `src/ipc.ts`，未知 code 回退消息。当前只提供简体中文，迁移规则见 `docs/i18n.md`。

程序级语言偏好由 `backend/preferences.cjs` 解析，通过原有 `settings.json` 持久化。`null` 为将来的跟随系统模式保留，准备阶段与未知值均显示中文。`src/LocaleRoot.tsx` 订阅已保存的语言状态，更新页面语言、标题并刷新已迁移文案，不重新挂载页面或修改编码设置 / 预设 / 正在执行的任务；正式选择器在第二种语言交付时开放。

视频设置、队列操作、RTX 与底部概览的已迁移文字在原位刷新，保留编辑值、选中任务和进度。校验问题逐项保留错误码 / 参数，兼容修复与重试按稳定技术字段决定；阶段、通知和新预览摘要在显示时格式化。长错误和操作按钮允许换行，关闭按钮保持可见、可操作，不缩字号。用户文件名、预设保存名、路径和命令值保持原文；旧记录 / 未知外部诊断有可读回退。FileMeta、对齐、管理及插件剩余路径仍按 B3–B6 迁移。

MMD 导出弹窗由 `src/MmdExportDialog.tsx` 管理，使用共享 Field / Select / Button / Modal，文案与原生插件设置框共用中文基准表。插件读取 `mmd-export.json` 的有限文案快照；窗口保留打开时的语言，下次打开读取最新快照，主程序关闭后仍可使用。缺失文案使用从同一中文表生成的 DLL 回退。固定窗口遇到长文字按实际字体测量并扩展空间，不缩字号。测试当前选项不保存，确定才保存，取消保留原选择；结果只简写在测试按钮，完整失败原因保留日志。文件框、其他页面及插件剩余路径仍按 B 批迁移，不能把 A4 样板当作全量支持。

| Capability      | Canonical owner                               | Source of truth     | Allowed variants                       | Verification           |
| --------------- | --------------------------------------------- | ------------------- | -------------------------------------- | ---------------------- |
| Select/Listbox  | src/components.tsx Select                     | DESIGN.md           | native Windows popup                   | desktop keyboard tests |
| Form            | src/components.tsx Field + backend validation | backend/service.cjs | settings / preset                      | integration + UI       |
| Scrollbar       | src/style.css global baseline                 | DESIGN.md           | bounded logs                           | computed style         |
| Toast           | src/App.tsx Notice                            | this contract       | status / error                         | live region            |
| CRUD            | preset dialog + service                       | backend/service.cjs | builtin editable + restorable / custom | CRUD UI test           |
| Table Selection | queue focus button                            | this contract       | single item detail                     | keyboard + pagination  |

Queue is a paged list, 10 entries per page, single focused item for detail; start applies current settings to waiting tasks, not only focused item. Search state is not required: no search box and transient private local paths never enter URLs. Page clamps after deletion. Source file removal only removes a queue item and never deletes the file. Clear completed is reversible by re-add and needs no confirmation.

Settings persist atomically and immediately; presets require explicit save, with modified status relative to selected preset. Switching preset while modified uses application dialog. Output location is a remembered global preference and is retained across preset changes. Start freezes settings per job. Disabled start states explain absence of inputs/engine/validation.

视频队列在结果状态后显示已提交的成品文件名；双文件遮罩显示两项，仅遮罩显示一项，部分完成只展示提交成功的部分。完整路径在悬停提示中，长文件名从中部省略且保留完整可访问文字。计划中的遮罩路径由后端留作重试，不能冒充成品发送给显示层。输出概览位于 page 内，内容由 page-scroll 独立滚动，宽窄窗口和滚动前后都保持底栏贴底；测试工作台必须沿用同一容器结构，诊断通知不得挤占底栏下方空间。

遮罩三选只在分离 / 仅遮罩时出现，默认无损；有损提示说明半透明边缘风险。实际编码器与质量显示来自预览数据，GPU 回退原因进入任务说明和日志，语言刷新不清除选择。视频音频码率没有“默认”项，新设置 / 个人预设为 320 kbps，旧 0 不自动换算；音视频工具的“跟随源文件”0 保留。超分补帧用控件本身的标签说明分组，不增加重复小标题，组间分隔不变。

Shared presentation owns render-time status/audio/fade labels, Intl display formats, encoder labels and preset-name projection. Stable status/option values drive behavior. Built-in default names use stable IDs/name keys; saved names and settings remain command/data authority. Explicit renames and personal names remain user content; legacy overrides without name intent conservatively keep their saved names. Display collisions annotate defaults with stable IDs, preserving user names and locale-independent saved-name conflict checks. PresetChoice/PresetList consume shared Select/Button/drag behavior, with App owning selection, drafts and operations. Shared actions retain error descriptors; App formats them at render time. Plugin config carries displayName separately from raw name/settings, with legacy fallback in the DLL.

VideoSettingsPanel / VideoSettings own video settings presentation through explicit values and callbacks; App owns draft targets, selected presets and persistence. EncodeFooter and VideoFeedback present the existing output/run and compatibility controls. EncodeQueue and RtxSettings receive only their relevant resource/status slices. The backend queue owns frozen settings and scheduling; encode-job owns one job's process/output transaction through explicit runner, commit and status/log capabilities. Service retains shared resources, stop state and evidence ownership.

Empty queue invites file selection or drop. Probe errors stay on the item. Encoding errors expose persistent logs and retry. Hardware fallback is explicit with parameters shown before retry. Progress comes from engine output. Unknown remaining time is not invented. Processing continues other items on failure. Completed main video + failed mask is partial success.

Modal dialogs are Radix-owned, labelled with title/description, Escape supported and focus restored. Delete preset confirmation initially focuses Cancel. Save errors keep dialog/input. Notice live region is polite, persistent field/job errors stay inline. Every interactive control uses native button/input/select semantics and visible focus, labelled icons and disabled states.

App has one natural document scroll owner; queue page bounds dataset and log panel has internal scroll. Sticky action strip must not cover final form fields. Test narrow width, long paths, keyboard and reduced motion. Windows native select popup visual behavior accepted explicitly.

Tool management is owned by backend/tools.cjs with the existing engine modal. Initial setup prompts only after locating managed tools; an installed offline version stays usable without network checks. Check/update are explicit actions. Download progress uses actual byte counts; unknown totals stay unknown. Errors persist and provide Retry. Active tasks and RTX verification exclude updates; staged releases activate only after validation, keeping old versions.

Compatibility is owned by core.compatibility and the shared IPC result. Suggestions atomically patch related fields; they retain Alpha and unrelated FPS/size/output preferences. Hardware Alpha is offered only after the real device probe. Inherently unsupported combinations (RTX plus Alpha) explain the conflict; no silent feature removal.

Media extraction/merge uses a separate function page and the same form/button/status primitives. First streams are explicit. Video copying defaults to MP4 and falls back to MKV (logged) when the copied video or chosen audio does not fit MP4; WAV is audio-only or PCM within MKV. A waiting item removed during a run is withdrawn and not processed. Existing destinations and input overwrite are rejected. Cancel cleans temporary files; logs and errors persist. File details read ffprobe on actual files and show “尚未生成文件” before output exists.

RTX filters are opt-in and NVEncC-only. Selected modes must pass a real test including output dimensions/FPS. VFG requires Windows, NVEncC 9.36+, Ada/Blackwell and installed NVIDIA model/runtime support. Changing relevant parameters invalidates the previous signature. A failed probe never falls back to ordinary resize/frame duplication.
