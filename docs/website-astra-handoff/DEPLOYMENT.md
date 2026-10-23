# 官网部署

正式地址：https://mmdencoder-website.stormybetta32.chatgpt.site

部署状态：succeeded（2026-10-23）。

发布平台：Sites；访问范围：public。官网源码仍以本目录 `index.html` 为准，不修改主程序。

## 托管身份

- Project ID: `appgprj_6adb7068f3f48191a22ac84f78ae770b`
- Slug: `mmdencoder-website`
- Version: `1`
- Version ID: `appgprj_6adb7068f3f48191a22ac84f78ae770b~appgver_56c29d4b063c8191a0398d189d8776ce`
- Deployment ID: `appgdep_6adb7109198c8191bada6879065e133f`
- GitHub source commit: `025a8a7b7dc7a97e0208c09350e3899b36e27f01`
- Sites source commit: `9d7e28afa654293803e7202663f6d46d79da75d8`
- Static directory: `dist`
- HTML SHA-256: `b04ca136dfb4822698b7b15a0cba33497c0bd24298d8578959a7623603fb9026`

后续更新应复用此 Project ID，不创建新站点。将本目录 HTML 同步到 Sites 源仓库 `dist/index.html`；托管清单为 `.openai/hosting.json`。推送源码后保存对应版本并部署，保留 public 访问范围。凭据应通过 Sites 工具重新获取，不保存在仓库。

## GitHub Pages 状态

已创建独立 `gh-pages` 分支，提交 `fbf584e`，包含同版 HTML 和 `.nojekyll`。GitHub 集成没有创建 Pages 站点的权限，API 返回 `403 Resource not accessible by integration`，因此 GitHub Pages **未启用**；正式托管改用 Sites。没有合并 main，也没有改动主程序或其构建流程。
