<div align="center">
  <img src="./public/app-icon.png" alt="Motrix" width="128" />
  <h1>Motrix for Android</h1>
  <p>A full-featured download manager that runs entirely on your phone</p>
</div>

[![Latest APK](https://img.shields.io/badge/APK-android--latest-blue)](https://github.com/MOYIre/Motrix-of-Android/releases/tag/android-latest)

English | [简体中文](./README.zh-CN.md)

## Overview

**Motrix for Android** is a self-contained download manager built from the
[Motrix Turbo](https://github.com/agalwood/Motrix) codebase. The APK embeds the
same Node server, aria2 download engine and React web UI that the desktop app
uses — nothing runs on a remote server, and no companion app is required.

- HTTP / FTP / BitTorrent / magnet link downloads
- Download engine (aria2) and task database run locally on the device
- Plugin ecosystem from the Motrix web interface
- Foreground service keeps downloads going when the app is in the background

## Install

Download `app-release.apk` from the latest release:

**[https://github.com/MOYIre/Motrix-of-Android/releases/tag/android-latest](https://github.com/MOYIre/Motrix-of-Android/releases/tag/android-latest)**

Notes:

- The APK is signed by the cloud build with a key managed in repository
  secrets; the repository itself contains no keystore.
- Granting "All files access" lets downloads land in the public `Download`
  folder; without it they go to app-private storage instead.
- The interface defaults to Simplified Chinese; switch it from the app's
  settings.

## How it is put together

```text
APK
├── jniLibs/arm64-v8a/             executed by the app
│   ├── libnode.so                 Node interpreter (Termux build)
│   ├── libaria2c.so               aria2 download engine
│   ├── libmotrix-finalize-fs.so   safe-finalize sidecar
│   └── lib*.so                    their shared libraries
├── assets/runtime.zip             read-only payload, unpacked on first launch
│   ├── dist/server                Node server bundle
│   ├── dist/renderer-web          web UI served by the server
│   └── node_modules               production dependency closure
└── Kotlin shell                   WebView + foreground service
```

Android only executes files from its native library directory, so the
interpreter and engine are staged there as `lib*.so` entries with rewritten
sonames (`patchelf`, `$ORIGIN` runpath). Everything else — the server bundle,
the web UI, the plugin runtime — ships inside `assets/runtime.zip` and is
unpacked into app-private storage. The WebView loads the server's own loopback
origin, which reuses the web UI's cookie session, WebSocket event stream and
RPC transport unchanged.

## Building

Cloud builds are the supported path: `.github/workflows/android.yml` assembles
the server bundle, cross-compiles `better-sqlite3` and the finalize sidecar for
arm64, stages the pinned Termux packages, and publishes the signed APK to the
`android-latest` release. Trigger it from the **Actions** tab (or
`gh workflow run android.yml`).

The packaging path can also run against a local Termux installation:

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

## Limitations

- **Single ABI:** the runtime artifacts are `arm64-v8a` only.
- **Storage:** downloads write directly to user-visible folders, which is why
  all-files access is requested (the download-manager category on Android 11+).
- **Web UI, not native:** the interface is the project's web renderer in a
  WebView; a native Compose UI is a future direction, not a promise.
- **Licensing:** the APK redistributes aria2 (GPLv2-or-later) alongside Node
  (MIT) and their libraries. Public distribution must ship the license texts
  and, for the GPL components, source or a written offer for it.

## License

[MIT](./LICENSE), inherited from Motrix. The bundled aria2 engine is GPLv2-or-later.
