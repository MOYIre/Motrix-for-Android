# Motrix for Android

Motrix runs on Android as a self-contained download manager: the APK embeds the
same Node server and aria2 engine the desktop and container builds use, and
renders the existing web UI in a WebView. No companion server is required.

## How it is put together

```text
APK
├── jniLibs/arm64-v8a/          executed by the shell, never read by the server
│   ├── libnode.so              Node interpreter (Termux build)
│   ├── libaria2c.so            aria2 download engine (Termux build)
│   ├── libmotrix-finalize-fs.so safe-finalize sidecar (built from packages/finalize-fs)
│   └── lib*.so                 shared libraries the three binaries link against
└── assets/runtime.zip          read-only payload, unpacked on first launch
    ├── dist/server             Node server bundle
    ├── dist/renderer-web       web UI served by the server
    ├── dist/builtin-plugins    builtin plugin artifacts
    ├── node_modules            production dependency closure
    └── extra/aria2.conf        engine configuration template
```

Android only allows an app to execute files that live in its native library
directory, which is why the interpreter, the engine and the sidecar are staged
as `lib*.so` entries there, and why every library they link against is renamed
to a `lib*.so` name with `patchelf` (the loader matches `DT_NEEDED` names, and
Gradle only packages `lib*.so`). Everything else — including the plugin
runtime's worker script — only has to be readable, so it ships inside
`assets/runtime.zip` and is unpacked into app-private storage.

The WebView loads `http://127.0.0.1:<port>/` — the server's own origin — so the
existing same-origin session cookie, WebSocket event stream and RPC transport
work unchanged. The shell only unlocks the control plane once: the server mints
an operator token (or accepts `MOTRIX_OPERATOR_TOKEN`), and the shell proves
possession of the same secret before the SPA boots.

## Building

Cloud builds are the supported path; the APK is assembled by
`.github/workflows/android.yml`, which:

1. builds the server bundle (`vite build` for server, worker and web renderer),
2. cross-compiles `better-sqlite3` for `arm64-linux-android` with the NDK,
3. builds the finalize sidecar for `aarch64-linux-android`,
4. stages the Termux packages pinned in `scripts/android/termux-packages.json`,
   rewrites their sonames and packages everything into `jniLibs` and
   `assets/runtime.zip`, and
5. assembles the signed release APK with Gradle.

Locally the same staging logic runs against an existing Termux installation:

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

`--from-prefix` skips the network and copies the runtime leaves out of a local
Termux prefix, which is how the packaging path is validated on a device before a
cloud build exists. Without it the pinned `.deb` packages are downloaded and
verified against their SHA512 digests.

## Notes and limitations

- **Single ABI.** The runtime artifacts are `arm64-v8a` only.
- **Storage.** The app requests all-files access (the download-manager category
  on Android 11+), because tasks write directly to user-visible folders such as
  `Download`.
- **Signing.** The release key lives in GitHub Actions secrets
  (`ANDROID_KEYSTORE_*`); nothing is committed to the repository. Provision it
  once with `scripts/android/create-release-keystore.mjs`.
- **Licensing.** The APK redistributes aria2 (GPLv2-or-later) together with Node
  (MIT) and their shared libraries. Any public distribution must ship the
  corresponding license texts and, for the GPL components, the source or a
  written offer for it.
- **Foreground service.** Downloads run inside a `dataSync` foreground service,
  so the engine survives the app leaving the foreground.
