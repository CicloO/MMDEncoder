# UX contract

Locale zh-CN, local Windows desktop, offline by default. No accounts or uploads.

| Capability      | Canonical owner                               | Source of truth | Allowed variants           | Verification           |
| --------------- | --------------------------------------------- | --------------- | -------------------------- | ---------------------- |
| Select/Listbox  | src/components.tsx Select                     | DESIGN.md       | native Windows popup       | desktop keyboard tests |
| Form            | src/components.tsx Field + backend validation | API.md          | settings / preset          | integration + UI       |
| Scrollbar       | src/style.css global baseline                 | DESIGN.md       | bounded logs               | computed style         |
| Toast           | src/App.tsx Notice                            | this contract   | status / error             | live region            |
| CRUD            | preset dialog + service                       | API.md          | builtin read-only / custom | CRUD UI test           |
| Table Selection | queue focus button                            | this contract   | single item detail         | keyboard + pagination  |

Queue is a paged list, 20 entries per page, single focused item for detail; start applies current settings to waiting tasks, not only focused item. Search state is not required: no search box and transient private local paths never enter URLs. Page clamps after deletion. Source file removal only removes a queue item and never deletes the file. Clear completed is reversible by re-add and needs no confirmation.

Settings persist atomically and immediately; presets require explicit save, with modified status relative to selected preset. Switching preset while modified uses application dialog. Output location is a remembered global preference and is retained across preset changes. Start freezes settings per job. Disabled start states explain absence of inputs/engine/validation.

Empty queue invites file selection or drop. Probe errors stay on the item. Encoding errors expose persistent logs and retry. Hardware fallback is explicit with parameters shown before retry. Progress comes from engine output. Unknown remaining time is not invented. Processing continues other items on failure. Completed main video + failed mask is partial success.

Modal dialogs are Radix-owned, labelled with title/description, Escape supported and focus restored. Delete preset confirmation initially focuses Cancel. Save errors keep dialog/input. Notice live region is polite, persistent field/job errors stay inline. Every interactive control uses native button/input/select semantics and visible focus, labelled icons and disabled states.

App has one natural document scroll owner; queue page bounds dataset and log panel has internal scroll. Sticky action strip must not cover final form fields. Test narrow width, long paths, keyboard and reduced motion. Windows native select popup visual behavior accepted explicitly.

Tool management is owned by backend/tools.cjs with the existing engine modal. Initial setup prompts only after locating managed tools; an installed offline version stays usable without network checks. Check/update are explicit actions. Download progress uses actual byte counts; unknown totals stay unknown. Errors persist and provide Retry. Active tasks and RTX verification exclude updates; staged releases activate only after validation, keeping old versions.

Compatibility is owned by core.compatibility and the shared IPC result. Suggestions atomically patch related fields; they retain Alpha and unrelated FPS/size/output preferences. Hardware Alpha is offered only after the real device probe. Inherently unsupported combinations (RTX plus Alpha) explain the conflict; no silent feature removal.

Media extraction/merge uses a separate function page and the same form/button/status primitives. First streams are explicit. Video copying uses MKV; WAV is audio-only or PCM within a compatible video container. Existing destinations and input overwrite are rejected. Cancel cleans temporary files; logs and errors persist. File details read ffprobe on actual files and show “尚未生成文件” before output exists.

RTX filters are opt-in and NVEncC-only. Selected modes must pass a real test including output dimensions/FPS. VFG requires Windows, NVEncC 9.36+, Ada/Blackwell and installed NVIDIA model/runtime support. Changing relevant parameters invalidates the previous signature. A failed probe never falls back to ordinary resize/frame duplication.
