# MMDEncoder 官网设计上下文

## Preference

用户明确更喜欢原版版式。保留粗体标题、山野插画、倾斜窗口、彩色功能卡、蓝色 MMD 专区；贯穿整页的长胶卷已按用户要求删除；后续迭代以精修为主，不重新换成出版式宋体或极简编辑台。

## Tokens and ownership

index.html 的 :root 是官网唯一运行时 token 源：paper `#f8faff`、ink `#171b38`、sub `#505b76`、blue `#354de0`、blue-deep `#283fc3`、line `#d5dcec`。--font 管理粗体标题，--body 管理正文，--mono 管理技术注释。保留原图形的局部颜色。--scroll-thumb/track/hover/active 管理全局滚动条。

本页为独立营销网站，不使用桌面主程序的根目录 DESIGN.md、UX-CONTRACT.md 或 token 生成器。原生语言 select 的系统弹层为有意选择；移动端使用原有三语言按钮。FAQ 为 details/summary；对比为原生 range；切换使用 tablist 和方向键；导航为非模态展开区。

## Audience and locale

全球 MMD 创作者、剪辑与后期用户；包含日语界面，不涉及日本特有交易或身份流程。技术说明以中文与 README.md 为准。日文正文采用说明体，日文系统字体优先，并检查混合 Latin 与长标题。无在线字体、CDN 或运行时依赖。

## Motion and layout

保留原有 1440px 最大内容宽度以及 1150/850/620px 断点。正文默认可见；动画观察器缺失仍可读。暂停按钮及 reduced motion 禁止自动运动。不再保留全页胶卷、齿孔生成和路径测量。

## Verification

浏览器可复现检查位于 qa/browser_check.py；实际结果与限制见 QA_NOTES.md。原生 select 和通过 addEventListener 连接的按钮由实际交互测试确认，静态审计误报不应促使加入空 onclick 或更改真实业务行为。
