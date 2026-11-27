# Dsh 文献翻译

面向 Windows 的 PDF 论文阅读与翻译工具。划选 PDF 中的文字即可在侧栏查看译文，并可在连续阅读中滚动跨页、用 Ctrl + 滚轮缩放。

## Windows 下载

- [安装版（.exe）](https://github.com/SihaoDong/dsh-literature-translation/releases/download/v0.2.19/Dsh-0.2.19-Windows-x64-Setup.exe) · 双击运行安装程序。
- [便携版（.zip）](https://github.com/SihaoDong/dsh-literature-translation/releases/download/v0.2.19/Dsh-0.2.19-Windows-x64-Portable.zip) · 完整解压后运行 Dsh文献翻译.exe。
- [查看发布说明和全部附件](https://github.com/SihaoDong/dsh-literature-translation/releases/tag/v0.2.19#assets)

## 功能

- 离线英译中与用户自配在线翻译服务
- 全文翻译、断点续译、逐页对照，以及 TXT 和双语 PDF 导出
- 基于 PDF 摘录的问答、参考页跳转和学术写作
- 标准 PDF 批注、裁剪和旋转，支持另存及受保护的原件写回

## 运行源码

需要 Windows、Node.js 和 npm。在仓库目录运行：

```powershell
npm ci
npm run desktop
```

开发启动与成品安装包的运行环境不同。仓库提供应用源码和 Windows 安装器配置。离线 Qwen、Argos/OPUS-MT、Electron 安装文件以及它们所需的运行时需单独准备。打开「设置」可配置自己的翻译服务。不要将 API 密钥写入源码或提交配置文件。

构建安装器时，现有脚本需要 NSIS 和预先打包的 Windows 便携 ZIP，目录及版本应遵循 `build-installer.ps1` 中的约定。

## 许可证

本仓库自有代码采用 [MIT](LICENSE)。第三方依赖、运行时、模型及其权重适用各自许可证，见 [第三方组件说明](THIRD_PARTY.md)。
