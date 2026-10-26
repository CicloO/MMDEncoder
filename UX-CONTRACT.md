# UX contract

Locale zh-CN, local Windows desktop, offline by default. No accounts or uploads.

已迁移文案由 `locales/zh-CN.json` 和 `src/i18n.ts` 管理。业务错误用稳定 code 与参数跨 IPC 传递；迁移后的调用方使用 `src/ipc.ts`，未知 code 回退消息。当前只提供简体中文，迁移规则见 `docs/i18n.md`。

程序级语言偏好由 `backend/preferences.cjs` 解析，通过原有 `settings.json` 持久化。`null` 为将来的跟随系统模式保留，准备阶段与未知值均显示中文。`src/LocaleRoot.tsx` 订阅已保存的语言状态，更新页面语言、标题并刷新已迁移文案，不重新挂载页面或修改编码设置 / 预设 / 正在执行的任务；正式选择器在第二种语言交付时开放。

视频设置、队列操作、RTX 与底部概览的已迁移文字在原位刷新，保留编辑值、选中任务和进度。校验问题逐项保留错误码 / 参数，兼容修复与重试按稳定技术字段决定；阶段、通知和新预览摘要在显示时格式化。长错误和操作按钮允许换行，关闭按钮保持可见、可操作，不缩字号。用户文件名、预设保存名、路径和命令值保持原文；旧记录 / 未知外部诊断有可读回退。音视频页面、管理及插件剩余路径仍按 B3–B6 迁移。

AlignDialog 通过 useAlignSession 拥有解码音轨、对齐值、请求阶段、错误与取消清理；波形视图和播放控制仍由弹窗与既有 useAlignPlayer 管理。会话只接文件 / 打开参数与必要回调。打开的弹窗按当前语言刷新按钮、步骤、提示与错误，保留偏移、trim、视图和试听设置，不重新启动请求；取消只由 ALIGN_CANCELLED 决定，未知诊断保持原文。实际帧率与独立帧偏移在 B3 后续功能中实施。

剪辑替换音频与波形 / 整数帧偏移属于当前剪辑会话，不记入选项。选择或拖入音频即自动匹配，复用共用换音频流程及 AlignmentTasks 取消 / 身份管理；无参考片段时等第一段就绪。波形偏移以整段源视频为基准，帧偏移正数延后、负数提前；导出按实际分数帧率计算，并仅叠加一次第一片段起点。MMD 帧号显示开关只影响片段输入。波形按钮复用 AlignmentIcon 与 reduced-motion 规则；打开窗口先停止后台匹配，应用保存两值，取消保持原值，重新匹配保留帧偏移，换音频重置两值。对齐期间不能导出尚未确定的偏移。

音频对齐窗口的“缩放 / 微调 / 音频偏移（帧）”使用同一排控件组，统一标签、控件高度与组间距；帧值输入为紧凑数字框，配同规格左右按钮：左提前一帧、右延后一帧，隐藏原生上下微调器；窄窗口按组自然换行。视频参考不重复显示方向 / FPS 注释，实际分数帧率保留在输入框标题；仅音频参考的 30 FPS 回退提示与校验信息保留，并通过 aria-describedby 关联输入。此布局用于共享对齐窗口的全部入口。

剪辑画面使用随可用宽度缩放的 16:9 预览框；图像在明确的宽 / 高内 object-fit: contain，非 16:9 画幅留黑边、完整显示，素材固有尺寸不参与撑高容器。预览尺寸不改变帧号、范围、切点或导出参数。

可直接解码的剪辑源在此框中播放；从当前播放头到不包含的出点，停止后落在最后一帧。暂停 / 手动定位后以原分数帧率同步画面与帧号，播放本身不改变切点吸附规则。不能解码或直接读取失败时保留逐帧 JPEG 并提示；播放时不请求 JPEG。切换源、离开剪辑页、开始导出时停止播放，卸载 src 释放文件。媒体协议仅解析当前 ready 片段 ID，权限与路径权威属于后端队列，界面不能提交任意路径；不生成代理视频。

直接播放以索引中的首视频时间戳换算零基剪辑帧号；正的非零起点可以播放、暂停、逐帧定位并按出点停止。暂停定位在目标帧的显示区间内，避免小数秒截断或容器时间戳舍入使画面落到前一帧；剪辑与导出仍使用原有精确帧坐标。负起点或实际跳转被播放器时长约束截短时，回退到目标帧的 JPEG 并提示，不能让帧号与画面不符。不改写源文件、不增加代理或扩展剪辑格式。

智能剪切开启时，拖动和逐帧键允许预览任意帧；无标签及 NVEncC 的实际入出点继续由后台吸附，按钮旁显示预计落点，出点允许结尾且不包含该帧。关闭智能剪切恢复拖动吸附；明确的逐帧键和跳可切位置键保持原语义。时间轴 range 高度 28px，不受文本输入框最小高度影响，圆点、轨道、范围条和刻度同高；高对比度下时间轴标记使用系统颜色，并保留可见轨道与刻度。

FileMeta / MediaDetails 负责元数据显示，数字 / 时间随当前语言格式化，技术 ID、原始 ffprobe JSON 与用户路径保持原文。实际详情读取由 file-details 通过窄查询 / runner 能力执行；源文件不存在、输出未生成和读取失败保留 code / 参数及诊断回退，语言刷新只重新格式化，不重跑 ffprobe。

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

About shows version/update and author/support sections without a bundled version changelog or Markdown renderer. The release-description link belongs to software updates: it opens Releases without a newer version and the validated download page when an update exists. Brand/support and the shared fixed dialog height remain unchanged. The repository changelog stays maintained; portable builds do not copy it.

App has one natural document scroll owner; queue page bounds dataset and log panel has internal scroll. Sticky action strip must not cover final form fields. Test narrow width, long paths, keyboard and reduced motion. Windows native select popup visual behavior accepted explicitly.

Tool management is owned by backend/tools.cjs with the existing engine modal. Initial setup prompts only after locating managed tools; an installed offline version stays usable without network checks. Check/update are explicit actions. Download progress uses actual byte counts; unknown totals stay unknown. Errors persist and provide Retry. Active tasks and RTX verification exclude updates; staged releases activate only after validation, keeping old versions.

Compatibility is owned by core.compatibility and the shared IPC result. Suggestions atomically patch related fields; they retain Alpha and unrelated FPS/size/output preferences. Hardware Alpha is offered only after the real device probe. Inherently unsupported combinations (RTX plus Alpha) explain the conflict; no silent feature removal.

Media extraction/merge uses a separate function page and the same form/button/status primitives. First streams are explicit. Video copying defaults to MP4 and falls back to MKV (logged) when the copied video or chosen audio does not fit MP4; WAV is audio-only or PCM within MKV. A waiting item removed during a run is withdrawn and not processed. Existing destinations and input overwrite are rejected. Cancel cleans temporary files; logs and errors persist. File details read ffprobe on actual files and show “尚未生成文件” before output exists.

媒体页的状态、选项、Hi-Res 和反馈在原位随语言刷新；autoAlign 提示保留原始错误参数，显示时格式化，外部日志原样保留。完成行复用 OutputFiles，在用时后显示已提交的实际文件名，路径在 title 中、长名中部省略，重排队清除旧显示。新无声视频与合并输出使用固定英文后缀 _no_audio / _merged，不随 locale 改名；这是用户对原命名不变约束的明确更新，目录和重名编号规则保持原样。

RTX filters are opt-in and NVEncC-only. Selected modes must pass a real test including output dimensions/FPS. VFG requires Windows, NVEncC 9.36+, Ada/Blackwell and installed NVIDIA model/runtime support. Changing relevant parameters invalidates the previous signature. A failed probe never falls back to ordinary resize/frame duplication.
