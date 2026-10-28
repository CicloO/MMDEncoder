---
version: alpha
colors:
  background: "#171b22"
  surface: "#202630"
  raised: "#29313e"
  border: "#3d4858"
  text: "#eef2f8"
  muted: "#a9b7c9"
  caption: "#8c9bad"
  captionRaised: "#8c9bad"
  primary: "#84b4ff"
  onPrimary: "#14243c"
  success: "#89d6b0"
  warning: "#f1c888"
  danger: "#ffa7ac"
  scrollbar: "#63738a"
  checkerLight: "#ffffff"
  checkerDark: "#000000"
  checkerText: "#888888"
  overlay: "#080b12bb"
  preview: "#101318"
  shadowSmall: "#00000044"
  shadowLarge: "#00000088"
  logoMain: "#f3f6fa"
  logoCyan: "#3ddbea"
  logoPink: "#ff5c8a"
lightColors:
  background: "#f3f5f8"
  surface: "#ffffff"
  raised: "#e8edf4"
  border: "#bcc7d6"
  text: "#1c293c"
  muted: "#526279"
  caption: "#647184"
  captionRaised: "#5f6c7d"
  primary: "#205caa"
  onPrimary: "#ffffff"
  success: "#246745"
  warning: "#805400"
  danger: "#b12f43"
  scrollbar: "#74859b"
  checkerLight: "#ffffff"
  checkerDark: "#000000"
  checkerText: "#888888"
  overlay: "#080b12bb"
  preview: "#101318"
  shadowSmall: "#00000044"
  shadowLarge: "#00000088"
  logoMain: "#1c2b45"
  logoCyan: "#1fb8cc"
  logoPink: "#ff4d7e"
typography:
  body:
    fontFamily: "Segoe UI, Microsoft YaHei UI, sans-serif"
    fontSize: "14px"
    lineHeight: "1.6"
  display:
    fontFamily: "Bahnschrift, Microsoft YaHei UI, sans-serif"
    fontSize: "26px"
  mono:
    fontFamily: "Cascadia Code, Consolas, monospace"
    fontSize: "12px"
rounded:
  control: "8px"
  panel: "12px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
components:
  button:
    height: "36px"
  field:
    height: "38px"
---

# MMDEncoder

## Overview

Product tool for Chinese-speaking MMD creators processing local rendered video. A quiet editing workstation, with a distinctive source-to-output signal strip that makes frame, color and container transformations legible. No marketing hero, fake activity, invented media thumbnails or decorative dashboards.

## Colors

Graphite surfaces keep attention on real video metadata. Blue carries safe primary actions, mint indicates completion, amber recoverable issues and rose failures. Status always has text. As requested on 2026-10-29, theme defaults to light and the header toggles only light and dark; it does not follow the system. The service's existing settings store persists this preference independently of encoding presets; previous localStorage values are not migrated. Both themes share layout and semantic tokens; forced colors remains operable. Overlay, preview, checkerboard and shadow tokens preserve their previous appearance in both themes. Startup window and document colors use the saved mode before rendering content.

## Typography

Bahnschrift for restrained Latin brand/large numeric metadata, Windows-native Chinese UI for reading; Cascadia/Consolas for codec values and logs. Use tabular numerals. No network fonts. Chinese labels lead, technical codec names are retained where useful.

## Layout

App document naturally scrolls. Desktop two columns (minmax(340px,1fr), 440px) with queue paging at 20; right settings do not get clipped to queue height. Below 980px stack settings under queue. Bottom sticky action bar in normal flow with content padding. Queue rows retain stable heights, filenames wrap safely in detail. Preset manager is a sibling surface using the same fields, buttons and feedback.

## Elevation & Depth

Borders separate functional panels; shadows only on dialog overlays. No gradients on cards. Subtle grid of frame ticks in empty source panel is the sole decorative signature.

## Shapes

8px controls and 12px panels. Badges have modest rounded corners, not pills everywhere.

Brand (2026-10-28, final screenshots and taskbar appearance approved by the user): use the supplied frame/wave/dot/cut-triangle artwork unchanged. The shared inline mark crops only empty viewBox margins, uses instance-unique SVG references and the semantic logoMain/logoCyan/logoPink tokens. Startup and About retain the 42 × 46px wrapper footprint; the mark is 36px with no redundant border or background frame. The 2026-10-29 header revision uses a 36 × 40px wrapper, an 8px brand gap and a 72px wide header, with compact wrapping on narrow windows. Its first navigation label shares the brand left origin at every breakpoint. The wordmark padding corrects the display font optical center without moving its outer alignment box. The supplied ICO is authoritative: its 16/24px simplified, 32/48px heavier and 64px+ full drawings come from curated PNGs, never one SVG resized to every size.

The user removed the tagline on 2026-10-28. Header mark, name and version badge align vertically on one row; About aligns the mark and name with its version block. No empty tagline slot or former version top offset remains. Both obsolete locale keys and their presentation rules are removed. The user also requested the Encoder wordmark segment in the theme's primary accent, while MMD keeps the normal text color; typography and alignment stay unchanged.

## Components

Canonical tokens: this frontmatter → scripts/tokens.mjs → src/tokens.css → shared CSS/classes in src/style.css. Generated tokens are never manually edited. Colors map --color-KEY, typography --font-ROLE, rounded --radius-KEY, spacing --space-KEY. Shared Field/Select/Button/Modal/Notice own semantics and styles. OS-owned native select popups are intentional for a Windows utility. Radix Dialog owns modal focus, inert background, Escape and restoration. Motion uses opacity/border transitions, plus the user-requested gentle waveform animation only while that task is automatically aligning. Reduced motion removes animation.

Field hierarchy (2026-10-28, complete item approved from all-page screenshots): field titles use 13px / 400 and the existing muted color; hints use 12px / 1.5 and the caption token. The user's review rejected the stronger Latin letters from weight 500 and requested fainter hints. Title-to-control spacing stays 7px, control-to-hint spacing is 4px, and fields end with 20px. Row-level and standalone field hints follow the same spacing without negative margins. Nested radio/color choices keep their control typography. Checkbox rows and cards use 14px regular body titles and 12px caption descriptions, aligned to the text column with a 4px gap. Caption colors retain at least 4.5:1 contrast on their backgrounds: caption on background/surface, captionRaised on raised containers. Values follow the same DESIGN.md → token generator → shared stylesheet path. The same generator emits desktop/theme-colors.json for the initial window background.

## Do's and Don'ts

Do show genuine encoder capabilities, paths and actionable recovery. Do preserve source precision such as 59.94 FPS. Do not infer bit depth or Alpha from file extension. Do not silently change settings or overwrite sources. No native browser alert/confirm/prompt; Windows file picker is appropriate desktop behavior.

Resolution uses source dimensions by default. Custom dimensions lock source aspect ratio by default; each batch item derives its other dimension from its own source. Alpha retention is explicit and incompatible codec combinations show actionable errors.

The top function navigation separates video encoding from media extraction/merge. Media tools reuse shared Field/Select/Button and the same panels, status colors and logs. RTX options occupy a settings tab, with VSR and VFG grouped separately. Compatibility fixes sit beside the explanation, describe the actual resulting codec, and only apply after a click. File details use the existing modal and real source/output metadata; missing output is an explicit state.

右上角“编码引擎 / 预设管理 / MMD 导出”统一为 752px 高（小窗口减至视口高度减 50px）。“关于”按用户 2026-10-27 确认改为内容自适应高度，上限仍为视口高度减 50px。默认内容无需外层滚动；溢出时整窗内容滚动，滚动条贴最右侧并按圆角裁切。列表弹窗利用剩余高度展示条目，操作区位于底部。“关于”不显示本版日志，发行说明入口归软件更新区；正式注册语言不足两种时隐藏语言区，标题及顶栏入口保留英文 Language。四个顶栏弹窗底部内容距边缘统一 24px。
