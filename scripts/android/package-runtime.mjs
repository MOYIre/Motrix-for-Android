#!/usr/bin/env node
// scripts/android/package-runtime.mjs
//
// Assemble the asset payload the APK ships and the native library directory it
// executes from.
//
//   node scripts/android/package-runtime.mjs \
//     --app android/app \
//     --termux-root <sysroot> --finalize-fs <binary> --better-sqlite3 <node addon>
//
// Two outputs:
//   <app>/src/main/jniLibs/arm64-v8a/*.so   interpreter, engine and sidecar
//   <app>/src/main/assets/runtime.zip       server bundle + production node_modules
//
// The zip holds everything the server reads at runtime but never executes as a
// program, which is why it can live in the app's private storage; anything the
// server spawns has to come from the native library directory instead.

import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main as fetchTermuxRuntime } from './fetch-termux-runtime.mjs'
import { main as installNativeLibs } from './native-libs.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..', '..')

// Runtime bundle inputs. `dist/` is the production build; `extra/` carries the
// aria2 configuration template the engine spawns with.
const BUNDLE_INPUTS = ['dist', 'extra']

export function parseArgs(argv) {
  const out = { flags: new Set() }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out.flags.add(token.slice(2))
      continue
    }
    out[token.slice(2)] = next
    index += 1
  }
  return out
}

// Production dependency closure, resolved through pnpm's flat layout. Returned
// names are directory names under <repo>/node_modules.
export async function resolveProductionClosure(repoRoot) {
  const rootManifest = JSON.parse(
    await readFile(path.join(repoRoot, 'package.json'), 'utf8')
  )
  const roots = [
    ...Object.keys(rootManifest.dependencies ?? {}),
    ...Object.keys(rootManifest.optionalDependencies ?? {}),
  ]
  const resolved = new Map()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()
    if (resolved.has(name)) continue
    const packageDir = path.join(repoRoot, 'node_modules', name)
    if (!existsSync(path.join(packageDir, 'package.json'))) {
      // Optional dependencies may be absent for the host; the server already
      // resolves that at runtime.
      continue
    }
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, 'package.json'), 'utf8')
    )
    const installation = name.startsWith('@')
      ? name.split('/')[1]
      : name
    resolved.set(name, { packageDir, manifest, installation })
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!resolved.has(dependency)) queue.push(dependency)
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      if (!resolved.has(dependency)) queue.push(dependency)
    }
  }
  return resolved
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
  }
}

export async function copyTree(source, destination) {
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
    verbatimSymlinks: false,
  })
}

async function assembleBundle(repoRoot, stagingRoot, options) {
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })

  for (const input of BUNDLE_INPUTS) {
    const source = path.join(repoRoot, input)
    if (!existsSync(source)) {
      throw new Error(
        `missing bundle input ${input}; run \`pnpm run build:server\` first`
      )
    }
    await copyTree(source, path.join(stagingRoot, input))
  }

  const closure = await resolveProductionClosure(repoRoot)
  const modulesDir = path.join(stagingRoot, 'node_modules')
  await mkdir(modulesDir, { recursive: true })
  for (const [name, entry] of closure) {
    const destination = path.join(modulesDir, name)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyTree(entry.packageDir, destination)
  }
  process.stdout.write(
    `[runtime] bundled ${closure.size} production packages\n`
  )

  // Native leaves are host-built during install; replace them with the Android
  // builds so the bundle is architecture-correct by construction.
  const betterSqlite3Root = path.join(modulesDir, 'better-sqlite3')
  if (existsSync(betterSqlite3Root)) {
    if (!options.betterSqlite3) {
      throw new Error(
        '--better-sqlite3 is required: the bundled addon must be the Android build'
      )
    }
    const target = path.join(
      betterSqlite3Root,
      'build',
      'Release',
      'better_sqlite3.node'
    )
    await mkdir(path.dirname(target), { recursive: true })
    await cp(options.betterSqlite3, target)
    await rm(path.join(betterSqlite3Root, 'prebuilds'), {
      recursive: true,
      force: true,
    })
  }

  const runtimeManifest = {
    name: 'motrix-android-runtime',
    version: options.version,
    node: options.nodeVersion,
    platform: 'android',
    arch: 'arm64',
  }
  await writeFile(
    path.join(stagingRoot, 'motrix-android-runtime.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`
  )
  return stagingRoot
}

async function packageBundle(stagingRoot, zipPath) {
  await mkdir(path.dirname(zipPath), { recursive: true })
  await rm(zipPath, { force: true })
  // -X keeps timestamps and extra attributes out of the archive so the same
  // inputs produce the same bytes; -9 maximises deflate compression.
  run('zip', [
    '-r',
    '-X',
    '-9',
    zipPath,
    'dist',
    'extra',
    'node_modules',
    'motrix-android-runtime.json',
  ], { cwd: stagingRoot })
}

async function readNodeVersion(sysroot) {
  const result = spawnSync(path.join(sysroot, 'bin', 'node'), ['-p', 'process.version'], {
    encoding: 'utf8',
  })
  if (result.status !== 0) return 'unknown'
  return result.stdout.trim()
}

async function main(argv) {
  const args = parseArgs(argv)
  const app = args.app
  if (!app) throw new Error('--app <android/app> is required')
  const appDir = path.resolve(REPOSITORY_ROOT, app)
  const workDir = args['work-dir']
    ? path.resolve(args['work-dir'])
    : path.join(REPOSITORY_ROOT, 'build', 'android')
  await mkdir(workDir, { recursive: true })

  const sysroot = path.join(workDir, 'termux')
  if (args['from-prefix']) {
    await fetchTermuxRuntime(['--out', sysroot, '--from-prefix', args['from-prefix']])
  } else {
    await fetchTermuxRuntime(['--out', sysroot])
  }

  const finalizeFs = args['finalize-fs']
  if (!finalizeFs || !existsSync(finalizeFs)) {
    throw new Error(
      '--finalize-fs must point at the Android build of motrix-finalize-fs'
    )
  }

  const jniLibs = path.join(appDir, 'src', 'main', 'jniLibs', 'arm64-v8a')
  // A prefix run stages only the binaries, so the libraries they reference are
  // resolved straight out of the live Termux installation.
  const librarySearch = args['from-prefix']
    ? ['--library-search', path.join(path.resolve(args['from-prefix']), 'lib')]
    : []
  await installNativeLibs([
    '--termux-root',
    sysroot,
    '--finalize-fs',
    path.resolve(finalizeFs),
    '--out',
    jniLibs,
    ...librarySearch,
    ...(args.flags.has('verify-run') ? ['--verify-run'] : []),
  ])

  const rootManifest = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8')
  )
  const stagingRoot = path.join(workDir, 'bundle')
  await assembleBundle(REPOSITORY_ROOT, stagingRoot, {
    version: rootManifest.version,
    nodeVersion: await readNodeVersion(sysroot),
    betterSqlite3: args['better-sqlite3']
      ? path.resolve(args['better-sqlite3'])
      : undefined,
  })
  const zipPath = path.join(appDir, 'src', 'main', 'assets', 'runtime.zip')
  await packageBundle(stagingRoot, zipPath)
  const { size } = await stat(zipPath)
  // The shell compares this marker with the one it unpacked last, so an app
  // update republishes the bundle without re-extracting on every launch.
  await writeFile(
    path.join(appDir, 'src', 'main', 'assets', 'runtime-version.txt'),
    `${rootManifest.version}\n`
  )
  process.stdout.write(
    `[runtime] assets/runtime.zip written (${(size / 1024 / 1024).toFixed(1)} MiB)\n`
  )
  return 0
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}

export { BUNDLE_INPUTS }
