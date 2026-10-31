# 官网 QA 结论

最终页面（2026-10-23 精修版，与 `gh-pages` 上发布的 `index.html` 一致）的测试结论与已知限制。

## 已修复的工程问题

- **手动语言选择优先**：存储被阻止时，延迟返回的 IP 检测结果不再覆盖用户手动选的语言。
- **键盘可用**：功能演示切换支持方向键、Home / End；菜单按 Escape 关闭并把焦点还给菜单按钮；对比滑块有可见焦点。
- **不依赖 JavaScript**：关闭 JavaScript、或浏览器不支持 IntersectionObserver 时，正文、导航和 FAQ 仍然可见可用。
- **更轻的页面**：删除全页胶卷和独立常驻动画后，DOM 节点从约 1101 个降到约 732 个，不再做胶卷重建和路径测量。保留的自动动画可暂停，并遵守 reduced motion。
- 修复手机宽度下“处理方式”区被固定成两列的问题。

## 已测试

- Chromium 实际渲染：中文 / 日文 / 英文 × 320、390、768、1440px，共 12 组，无横向溢出，标题、导航、各章节可见。
- 交互：手机菜单、语言选择刷新后保留、演示切换（点击与键盘）、对比滑块（拖动与键盘）、FAQ 键盘展开、动效暂停与 reduced motion。
- 语言检测：模拟 JP / CN / US 的 IP 响应，以及请求失败时回退浏览器语言。只测了模拟响应，没有测真实 GeoJS 服务。
- axe-core：三语 × 三个演示模式共 9 次 WCAG A / AA 自动扫描，零违规。自动扫描不能代替完整的人工无障碍审计。
- 页面为单文件，CSS / JS / SVG 全部内联，无外部字体、图片或 CDN。GeoJS 是唯一可选请求，失败不影响正文和交互。

## 已知限制

- **只在 Chromium 中测试，尚未在真实 iPhone Safari（WebKit）上测试。** 当时的环境缺少 WebKit 依赖库，未能运行。
- 日语已检查渲染和技术用语，但没有日语母语者的专业审校。
- 静态审计（frontend-design-premium strict）剩余 8 条“按钮无行为”是误报：它只识别 onclick，不识别本页用的 addEventListener；实际交互已复核。

## 复测

在 `website/` 下启动本地服务，再运行脚本：

```sh
python -m http.server 8765
python qa/browser_check.py --url http://127.0.0.1:8765 --output <输出目录>
node qa/accessibility.cjs
```

- `browser_check.py` 需要 Python Playwright，覆盖三语 × 四档宽度与上面的交互检查；`--engine webkit` 可在装好 Playwright WebKit 后补测 Safari 内核。
- `accessibility.cjs` 需要 Node 的 playwright 与 @axe-core/playwright。
- 两个脚本写于 Linux 环境，Chromium 路径固定为 `/usr/bin/chromium`；在 Windows 上运行时去掉 `executablePath` / `executable_path`，改用 Playwright 自带的浏览器。
- 结果与截图写到输出目录，不进仓库。
