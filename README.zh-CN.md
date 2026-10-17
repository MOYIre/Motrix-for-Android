<div align="center">
  <img src="./public/app-icon.png" alt="Motrix" width="128" />
  <h1>安卓版 Motrix</h1>
  <p>功能完整的下载管理器，完全运行在你的手机上</p>
</div>

[![最新 APK](https://img.shields.io/badge/APK-android--latest-blue)](https://github.com/MOYIre/Motrix-of-Android/releases/tag/android-latest)

[English](./README.md) | 简体中文

## 简介

**安卓版 Motrix** 基于 [Motrix Turbo](https://github.com/agalwood/Motrix)
代码库构建，是一个自带运行时的下载管理器。APK 内嵌了与桌面版相同的
Node 服务端、aria2 下载引擎和 React 网页界面 —— 一切都在本地运行，
不需要远程服务器，也不需要额外安装任何应用。

- 支持 HTTP / FTP / BitTorrent / 磁力链接下载
- 下载引擎（aria2）与任务数据库在设备本地运行
- 继承 Motrix 网页界面的插件生态
- 前台服务保证应用退到后台后下载继续

## 安装

从最新 Release 下载 `app-release.apk`：

**[https://github.com/MOYIre/Motrix-of-Android/releases/tag/android-latest](https://github.com/MOYIre/Motrix-of-Android/releases/tag/android-latest)**

说明：

- APK 使用随仓库提交的构建密钥签名 —— 适合个人安装，不用于商店发布。
- 授予"所有文件访问"权限后，下载会写入公共 `Download` 目录；未授予时
  落到应用私有目录。
- 界面默认简体中文，可在应用设置中切换。

## 组成结构

```text
APK
├── jniLibs/arm64-v8a/             由应用执行
│   ├── libnode.so                 Node 解释器（Termux 构建）
│   ├── libaria2c.so               aria2 下载引擎
│   ├── libmotrix-finalize-fs.so   安全 finalize 边车
│   └── lib*.so                    以上二进制的共享库
├── assets/runtime.zip             只读载荷，首次启动时解包
│   ├── dist/server                Node 服务端产物
│   ├── dist/renderer-web          服务端提供的网页界面
│   └── node_modules               生产依赖闭包
└── Kotlin 壳                      WebView + 前台服务
```

安卓只允许应用执行位于原生库目录中的文件，因此解释器与引擎以 `lib*.so`
形式放在那里，并通过 `patchelf` 改写 soname、设置 `$ORIGIN` 运行路径。
其余内容 —— 服务端产物、网页界面、插件运行时 —— 打包在
`assets/runtime.zip` 中，首次启动解包到应用私有目录。WebView 加载服务端
自身的回环源，直接复用网页界面的 Cookie 会话、WebSocket 事件流与 RPC 传输。

## 构建

云构建是受支持的路径：`.github/workflows/android.yml` 会组装服务端产物、
为 arm64 交叉编译 `better-sqlite3` 与 finalize 边车、整理固定的 Termux 包，
并把签名 APK 发布到 `android-latest` Release。可在 **Actions** 页面触发
（或 `gh workflow run android.yml`）。

打包流程也可以针对本机 Termux 环境运行：

```bash
pnpm run build:builtin
pnpm exec vite build --config vite.server.config.ts
pnpm exec vite build --config vite.worker.config.ts
pnpm exec vite build --config vite.renderer.web.config.ts
pnpm run build:android-runtime -- \
  --from-prefix "$PREFIX" \
  --finalize-fs packages/finalize-fs/target/release/motrix-finalize-fs \
  --better-sqlite3 node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

## 已知限制

- **单一 ABI**：运行时构件只有 `arm64-v8a`。
- **存储**：下载直接写入用户可见目录，因此会申请所有文件访问权限
  （Android 11+ 的下载管理器类别）。
- **网页界面而非原生**：界面是项目自带的 Web 渲染端，运行在 WebView 中；
  原生 Compose 界面是未来方向，不作承诺。
- **许可**：APK 重新分发了 aria2（GPLv2 或更高）以及 Node（MIT）和它们的
  库。公开分发必须附带相应许可证文本，对 GPL 组件还需附带源码或书面提供承诺。

## 许可证

[MIT](./LICENSE)，继承自 Motrix。内置 aria2 引擎为 GPLv2 或更高版本。
