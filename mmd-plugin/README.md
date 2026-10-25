# MMD 导出插件模块

插件以 DMO 的形式向 MMD 提供编码器。`build.cmd` 将以下独立编译单元链接成一个 `MMDEncoderPlugin.dll`，COM 注册与导出入口保持在 `plugin.cpp`。

| 模块                         | 职责                                                  | 依赖与状态边界                                                                                      |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `plugin.cpp`                 | COM / DMO、MMD 帧输入、编码生命周期、注册及日志所有者 | 组合各模块；持有模块句柄和日志对象                                                                  |
| `settings.cpp` / `.h`        | 原生导出设置窗口、选择读写、当前选项编码测试          | `showSettings(parent, module, directory, log)` 显式接收所需上下文；窗口选项属于本次 SettingsContext |
| `processes.cpp` / `.h`       | 参数引用、环境块、同步 helper 调用及等待              | helper 显式接收日志回调；需要保持窗口响应时传入该窗口，不引用插件日志单例                           |
| `json.cpp` / `.h`            | JSON 类型、解析与字符串序列化                         | 解析游标属于 JsonReader 实例；只依赖字符串转换，不读取配置或操作窗口                                |
| `platform.cpp` / `.h`        | UTF-8 / UTF-16 转换、Known Folder 路径、文件读取      | 仅依赖 Windows 和标准库；目录由调用方传给设置模块                                                   |
| `messages.cpp` / `.h`        | 一个窗口的 locale / 文案快照、参数格式化及中文回退    | 显式接收配置，不读取插件静态对象；回退数据由同一中文 JSON 生成                                      |
| `settings-layout.cpp` / `.h` | 按实际字体测量控件并适配长文案                        | 只接收窗口和测试按钮文字，不拥有设置、进程或语言状态                                                |

头文件声明公共类型和接口，实现位于各自 `.cpp` 中。设置、进程和 JSON 模块不引用 `plugin.cpp`、`g_module` 或 `Log::get()`；不通过 include 共享原文件中的静态实现。日志回调类型为 `ProcessLog`，由插件日志所有者提供。

设置框读取主程序保存的 locale / 有限文案表；主程序关闭后仍可用，窗口保持打开时的语言。缺失文字使用从 `locales/zh-CN.json` 自动生成的 DLL 回退，不在 C++ 中维护第二份译文。编码测试使用当前窗口选项，不保存；结果只简写在测试按钮，完整结果与失败原因写日志，不再弹结果框。导出设置窗口的“确定”才保存选项，“取消”保留已保存选择。

预设下拉框显示配置中的 `displayName`；旧配置缺失它时回退 `name`。显示名由主程序依据稳定 ID / nameKey 与名称来源生成，用户改名保留原文。原始 `name` / `settings.presetName` 与选择 ID 继续用于 helper 和编码数据，译名不写回这些字段。原生语言测试读取实际下拉项文本，并分别验证译名、用户原名及旧配置回退。

## 构建和验证

在仓库根目录使用 Node.js 和 VS 2022 C++ Build Tools，构建会先生成源语言回退数据：

```powershell
cmd /c mmd-plugin\build.cmd
node mmd-plugin/tests/e2e.mjs
node mmd-plugin/tests/locale.mjs
```

e2e 用 `mmd-sim.exe` 加载真实 DLL，模拟 DirectShow 帧输入，并运行实际 FFmpeg / NVEncC。locale 测试在主程序关闭时验证测试语言、中文回退、原生控件尺寸、失败日志及取消 / 保存，输出窗口快照。二者使用真实用户插件目录，运行前关闭 MMD / MMDEncoder，结束时恢复配置。此测试与真实 MMD 工程导出验收分别记录；模拟器的原生控件外观不代表 MMD 宿主的视觉样式。

后续改动落在大文件时，先明确职责、接口与状态边界，纯拆分单独提交，完成项目完整测试后再做功能改动。完整测试包含单元 / 集成测试、六组桌面流程和插件 e2e，不能仅以此处的 DLL 构建代替。
