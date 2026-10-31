# 官网部署

正式地址：<https://cicloo.github.io/MMDEncoder/>（GitHub Pages，也是仓库主页链接）。

- 发布源：`gh-pages` 分支根目录，只放 `index.html` 和 `.nojekyll`。
- 源码：本目录 `website/index.html`。官网与桌面程序相互独立，不参与打包，也不使用根目录的 DESIGN.md 或 token 生成器。

## 更新流程

1. 修改 `website/index.html`，按 [QA_NOTES.md](QA_NOTES.md) 复测。
2. 合并进 main。
3. 把同一份 `index.html` 提交到 `gh-pages` 分支并推送；GitHub Pages 会自动重新构建。
4. 核对 `gh-pages` 上的 `index.html` 与 `website/index.html` 内容一致，再打开正式地址检查。

最早一版曾临时托管在 ChatGPT Sites，现在以 GitHub Pages 为准。
