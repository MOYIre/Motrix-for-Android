# 安卓版 Motrix

安卓版把 Motrix 做成一个自带运行时的下载器：APK 内嵌与桌面版、容器版相同的
Node 服务端与 aria2 引擎，并用 WebView 渲染现有的 Web 界面，不需要额外的服务端。

## 组成结构

```text
APK
├── jniLibs/arm64-v8a/          由外壳进程执行，服务端不读取
│   ├── libnode.so              Node 解释器（Termux 构建）
│   ├── libaria2c.so            aria2 下载引擎（Termux 构建）
│   ├── libmotrix-finalize-fs.so 安全 finalize 边车（由 packages/finalize-fs 构建）
│   └── lib*.so                 以上三个二进制依赖的共享库
└── assets/runtime.zip          只读载荷，首次启动时解包
    ├── dist/server             Node 服务端产物
    ├── dist/renderer-web       服务端提供的 Web 界面
    ├── dist/builtin-plugins    内置插件产物
    ├── node_modules            生产依赖闭包
    └── extra/aria2.conf        引擎配置模板
```

安卓只允许应用执行位于其原生库目录（native library directory）中的文件，因此解释器、
引擎与边车都以 `lib*.so` 形式放在该目录；它们链接的每个库也都需要用 `patchelf`
改成 `lib*.so` 命名（加载器按 `DT_NEEDED` 名称查找，而 Gradle 只打包 `lib*.so`）。
其余内容（包括插件运行时的 worker 脚本）只需可读，因此打进 `assets/runtime.zip`，
首次启动解包到应用私有目录。

WebView 加载 `http://127.0.0.1:<端口>/`，即服务端自身的源，因此现有的同源会话
Cookie、WebSocket 事件流与 RPC 传输无需任何改动。外壳只需解锁一次控制面：服务端会
生成 operator 令牌（或接受 `MOTRIX_OPERATOR_TOKEN`），外壳在界面启动前证明持有同一密钥。

## 构建

云构建是受支持的路径，APK 由 `.github/workflows/android.yml` 组装，流程为：

1. 构建服务端产物（server、worker、web 渲染端三个 `vite build`）；
2. 用 NDK 为 `arm64-linux-android` 交叉编译 `better-sqlite3`；
3. 为 `aarch64-linux-android` 构建 finalize 边车；
4. 拉取 `scripts/android/termux-packages.json` 中固定的 Termux 包，改写其 soname，
   并把所有内容整理进 `jniLibs` 与 `assets/runtime.zip`；
5. 用 Gradle 组装已签名的 release APK。

本机可以用现有 Termux 安装运行同一套整理逻辑：

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

`--from-prefix` 跳过网络，直接从本机 Termux 前缀复制运行时文件，这是在云构建之前
在真机上验证打包路径的方式。不带该参数时会下载固定的 `.deb` 包并按 SHA512 校验。

## 说明与限制

- **单一 ABI。** 运行时构件只有 `arm64-v8a`。
- **存储。** 应用会申请所有文件访问权限（Android 11+ 的下载管理器类别），因为任务
  直接写入 `Download` 等用户可见目录。
- **签名。** `android/keystore/keystore.properties` 指向一个已提交的构建密钥，目的是
  让云构建不需要任何 secret；对外发布前请替换为私有密钥库。
- **许可。** APK 重新分发了 aria2（GPLv2 或更高）以及 Node（MIT）和它们的共享库。
  任何公开分发都必须附带相应许可证文本，对 GPL 组件还需附带源码或书面提供承诺。
- **前台服务。** 下载运行在 `dataSync` 前台服务中，因此应用退到后台后引擎仍会继续工作。
