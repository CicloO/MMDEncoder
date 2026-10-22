---
version: alpha
colors:
  background: "#171b22"
  surface: "#202630"
  raised: "#29313e"
  border: "#3d4858"
  text: "#eef2f8"
  muted: "#a9b7c9"
  primary: "#84b4ff"
  onPrimary: "#14243c"
  success: "#89d6b0"
  warning: "#f1c888"
  danger: "#ffa7ac"
  scrollbar: "#63738a"
lightColors:
  background: "#f3f5f8"
  surface: "#ffffff"
  raised: "#e8edf4"
  border: "#bcc7d6"
  text: "#1c293c"
  muted: "#526279"
  primary: "#205caa"
  onPrimary: "#ffffff"
  success: "#246745"
  warning: "#805400"
  danger: "#b12f43"
  scrollbar: "#74859b"
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

Graphite surfaces keep attention on real video metadata. Blue carries safe primary actions, mint indicates completion, amber recoverable issues and rose failures. Status always has text. Light (white/slate) is the initial theme; the header sun/moon icon toggles the graphite dark theme, persisted independently of encoding presets. Both themes share layout and semantic tokens; forced colors remains operable.

## Typography

Bahnschrift for restrained Latin brand/large numeric metadata, Windows-native Chinese UI for reading; Cascadia/Consolas for codec values and logs. Use tabular numerals. No network fonts. Chinese labels lead, technical codec names are retained where useful.

## Layout

App document naturally scrolls. Desktop two columns (minmax(340px,1fr), 440px) with queue paging at 20; right settings do not get clipped to queue height. Below 980px stack settings under queue. Bottom sticky action bar in normal flow with content padding. Queue rows retain stable heights, filenames wrap safely in detail. Preset manager is a sibling surface using the same fields, buttons and feedback.

## Elevation & Depth

Borders separate functional panels; shadows only on dialog overlays. No gradients on cards. Subtle grid of frame ticks in empty source panel is the sole decorative signature.

## Shapes

8px controls and 12px panels. Badges have modest rounded corners, not pills everywhere.

## Components

Canonical tokens: this frontmatter → scripts/tokens.mjs → src/tokens.css → shared CSS/classes in src/style.css. Generated tokens are never manually edited. Colors map --color-KEY, typography --font-ROLE, rounded --radius-KEY, spacing --space-KEY. Shared Field/Select/Button/Modal/Notice own semantics and styles. OS-owned native select popups are intentional for a Windows utility. Radix Dialog owns modal focus, inert background, Escape and restoration. Motion only opacity/border transitions; reduced motion removes it.

## Do's and Don'ts

Do show genuine encoder capabilities, paths and actionable recovery. Do preserve source precision such as 59.94 FPS. Do not infer bit depth or Alpha from file extension. Do not silently change settings or overwrite sources. No native browser alert/confirm/prompt; Windows file picker is appropriate desktop behavior.

Resolution uses source dimensions by default. Custom dimensions lock source aspect ratio by default; each batch item derives its other dimension from its own source. Alpha retention is explicit and incompatible codec combinations show actionable errors.

The top function navigation separates video encoding from media extraction/merge. Media tools reuse shared Field/Select/Button and the same panels, status colors and logs. RTX options occupy a settings tab, with VSR and VFG grouped separately. Compatibility fixes sit beside the explanation, describe the actual resulting codec, and only apply after a click. File details use the existing modal and real source/output metadata; missing output is an explicit state.

右上角“关于 / 编码引擎 / 预设管理 / MMD 导出”统一为 752px 高（小窗口减至视口高度减 50px）。默认内容无需外层滚动；溢出时整窗内容滚动，滚动条贴最右侧并按圆角裁切。列表弹窗利用剩余高度展示条目，操作区位于底部。“关于”的简略日志区固定 190px，高度溢出后独立滚动。四个顶栏弹窗底部内容距边缘统一 24px。
