# 官网精修 QA

## 最终范围

按用户最新反馈保留原版版式，在其基础上优化；已彻底删除贯穿全页的长胶卷及其 SVG、齿孔生成、路径测量、滚动监听。保留短的横向章节过渡、原插画和卡片。只修改 `docs/website-astra-handoff/`。

## 已执行

- Chromium 实际渲染中文、日文、英文 × 320 / 390 / 768 / 1440px，共 12 组全页截图与布局断言。修复原版手机处理方式区被高优先级 CSS 固定成两列的问题；检查标题、导航、正文与卡片插画。
- 菜单打开、Escape 关闭并返回焦点、锚点关闭；语言选择持久化；演示切换点击与方向键/Home/End；滑块鼠标拖动与键盘；FAQ 键盘展开。
- 动效暂停、reduced motion、无 JavaScript 下正文/导航/FAQ、IntersectionObserver 不可用时内容可见。
- GeoJS 模拟 JP / CN / US 响应、请求失败回退浏览器语言；存储不可用且 IP 响应延迟时，手动选择仍优先。未将模拟响应当作真实网络服务可用性测试。
- axe-core：三语 × 三个演示模式，9 次 WCAG A/AA 自动扫描，零违规。自动检查不能替代完整人工可访问性审计。
- 单文件内联 CSS / JS / SVG，无外部字体、图片、CDN 或前端运行时。GeoJS 是唯一可选请求，失败不会影响正文与交互。
- Prettier 检查与 `git diff --check`。未运行桌面程序构建/编码引擎测试：本次没有改动或依赖主程序。

## 性能与兼容性边界

移除全页胶卷后页面 DOM 从约 1101 降到约 732 个节点（浏览器与语言可能略有变化），不再进行胶卷重建或 getPointAtLength。滚动采样原始数据见 `qa/browser-results.json`：属于共享环境 Chromium 的短期诊断，不是性能宣传或真机流畅度保证。保留的自动动画可暂停。

环境 Chromium 策略禁止 `file://` 导航，因此使用本地 HTTP 渲染并验证无 JS/网络失败降级；未声称实测本机双击 HTML。Playwright WebKit 已尝试安装，但宿主缺少 GTK4、Graphene、Harfbuzz ICU、Manette、Hyphen、GLES 等库，未完成 WebKit/iPhone Safari 真机测试。日语已检查渲染与技术语义，但尚无日语母语专业审校。

## 静态审计解释

运行 frontend-design-premium 的 `audit_project.py --mode strict`，记录在 `qa/static-audit.json`。Select/Listbox 明确指定原生所有权。剩余 8 条 `affordance.actionless-button` 是静态扫描只识别 onclick、不能识别本页 addEventListener 的误报，分别对应三语言按钮、暂停、菜单与三个模式按钮。实际绑定与浏览器交互已复核，不添加空 onclick 规避扫描。没有未解决的真实按钮无行为问题。

## 复现

在本目录启动 `python -m http.server 8765`，另一个终端执行：

```sh
python qa/browser_check.py --url http://127.0.0.1:8765 --output /tmp/mmd-browser
```

需要 Python Playwright 与 `/usr/bin/chromium`。JSON 结果保存到输出目录，截图不进入源码。`qa/accessibility.cjs` 需要 Node 的 playwright 和 @axe-core/playwright，服务地址相同。

```sh
node qa/accessibility.cjs
prettier --check index.html DESIGN.md DESIGN_DECISIONS.md QA_NOTES.md qa/*.json qa/*.cjs
```

保留的结果文件对应最终页面；无主程序变更，无 main 合并。
