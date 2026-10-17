#!/usr/bin/env node
// scripts/android/native-libs.mjs
//
// Turn the Termux sysroot into an Android `jniLibs/arm64-v8a` directory.
//
// Android only lets an app execute binaries that live in its native library
// directory (`ApplicationInfo.nativeLibraryDir`), and the Gradle plugin only
// packages `lib*.so` entries there. Two consequences drive this stage:
//
//   1. the interpreter and engine are renamed to `libnode.so` / `libaria2c.so`
//      / `libmotrix-finalize-fs.so`, and
//   2. every library they link against must be `lib*.so` too, so versioned
//      sonames (`libcrypto.so.3`, `libicuuc.so.78`, ...) are rewritten with
//      patchelf — both the files and the `DT_NEEDED` references to them.
//
// Each file also gets `RPATH=$ORIGIN`, so once everything lands in the native
// library directory the loader resolves siblings without LD_LIBRARY_PATH.
//
//   node scripts/android/native-libs.mjs \
//     --termux-root <sysroot> --finalize-fs <binary> --out <jniLibs/arm64-v8a> \
//     [--verify-run]

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Libraries Android provides to every app process. They are never bundled;
// bundling a private copy of libc would break the device's own runtime.
const SYSTEM_LIBRARIES = new Set([
  'libc.so',
  'libm.so',
  'libdl.so',
  'liblog.so',
  'libandroid.so',
  'libstdc++.so',
  'libz.so', // provided by the platform; aria2/node bundle their own only if the device lacks it
])

const SONAME_RENAMES = new Map([
  ['libz.so.1', 'libz.so'],
  ['libcrypto.so.3', 'libcrypto.so'],
  ['libssl.so.3', 'libssl.so'],
  ['libicui18n.so.78', 'libicui18n.so'],
  ['libicuuc.so.78', 'libicuuc.so'],
  ['libicudata.so.78', 'libicudata.so'],
  ['libxml2.so.16', 'libxml2.so'],
])

const EXECUTABLE_RENAMES = new Map([
  ['node', 'libnode.so'],
  ['aria2c', 'libaria2c.so'],
  ['motrix-finalize-fs', 'libmotrix-finalize-fs.so'],
])

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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`
    )
  }
  return result.stdout
}

export function printNeeded(filePath) {
  const output = run('patchelf', ['--print-needed', filePath])
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function renameFor(soname) {
  return SONAME_RENAMES.get(soname) ?? soname
}

// Breadth-first walk of DT_NEEDED from the shipped executables. Libraries found
// in a search directory are bundled; anything else is assumed to come from the
// platform.
export function collectClosure(entryFiles, searchDirs, exists) {
  const needed = new Map()
  const missing = []
  const queue = [...entryFiles]
  const seen = new Set()
  const locate = (soname) => {
    for (const dir of searchDirs) {
      const candidate = path.join(dir, soname)
      if (exists(candidate)) return candidate
    }
    return undefined
  }
  while (queue.length > 0) {
    const current = queue.shift()
    for (const soname of printNeeded(current)) {
      if (SYSTEM_LIBRARIES.has(soname)) continue
      const bundledName = renameFor(soname)
      if (needed.has(bundledName) || seen.has(bundledName)) continue
      const source = locate(soname)
      if (!source) {
        missing.push({ from: path.basename(current), soname })
        continue
      }
      seen.add(bundledName)
      needed.set(bundledName, { source, original: soname })
      queue.push(source)
    }
  }
  return { needed, missing }
}

export async function main(argv) {
  const args = parseArgs(argv)
  const termuxRoot = args['termux-root']
  const finalizeFs = args['finalize-fs']
  const out = args.out
  if (!termuxRoot || !finalizeFs || !out) {
    throw new Error('--termux-root, --finalize-fs and --out are required')
  }

  const sysrootLib = path.join(termuxRoot, 'lib')
  const searchDirs = [
    sysrootLib,
    ...(args['library-search'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => path.resolve(entry)),
  ]
  const entries = [
    { source: path.join(termuxRoot, 'bin', 'node'), name: 'libnode.so', kind: 'executable' },
    { source: path.join(termuxRoot, 'bin', 'aria2c'), name: 'libaria2c.so', kind: 'executable' },
    { source: finalizeFs, name: 'libmotrix-finalize-fs.so', kind: 'executable' },
  ]
  // aria2 loads the OpenSSL "legacy" provider at startup. The provider module
  // gets the same soname/runpath treatment as every other library, so once the
  // shell copies it into the runtime as `legacy.so` (beside a `libcrypto.so`)
  // OpenSSL can load it inside the APK sandbox.
  const legacySource = path.join(termuxRoot, 'ossl-modules', 'legacy.so')
  if (existsSync(legacySource)) {
    entries.push({
      source: legacySource,
      name: 'liblegacy.so',
      kind: 'library',
      original: 'legacy.so',
    })
  }
  for (const entry of entries) {
    await stat(entry.source).catch(() => {
      throw new Error(`missing runtime entry: ${entry.source}`)
    })
  }

  const { needed, missing } = collectClosure(
    entries.map((entry) => entry.source),
    searchDirs,
    (candidate) => existsSync(candidate)
  )
  if (missing.length > 0) {
    throw new Error(
      `unresolved runtime dependencies:\n${missing
        .map((item) => `  ${item.from} needs ${item.soname}`)
        .join('\n')}`
    )
  }

  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const installed = []
  for (const entry of entries) {
    const target = path.join(out, entry.name)
    await copyFile(entry.source, target)
    await chmod(target, 0o755)
    installed.push({
      name: entry.name,
      kind: entry.kind,
      original: entry.original,
    })
  }
  for (const [name, detail] of needed) {
    const target = path.join(out, name)
    await copyFile(detail.source, target)
    await chmod(target, 0o755)
    installed.push({ name, kind: 'library', original: detail.original })
  }

  const names = installed.map((entry) => entry.name)
  const renamePairs = [...SONAME_RENAMES.entries()].filter(([, to]) =>
    names.includes(to)
  )

  for (const entry of installed) {
    const target = path.join(out, entry.name)
    run('patchelf', ['--set-rpath', '$ORIGIN', target])
    if (entry.kind === 'library' && entry.original !== entry.name) {
      run('patchelf', ['--set-soname', entry.name, target])
    }
    for (const [from, to] of renamePairs) {
      // --replace-needed is a no-op when the reference is absent.
      run('patchelf', ['--replace-needed', from, to, target])
    }
  }

  const problems = []
  for (const entry of installed) {
    const target = path.join(out, entry.name)
    for (const soname of printNeeded(target)) {
      if (SYSTEM_LIBRARIES.has(soname)) continue
      if (!names.includes(soname)) {
        problems.push(`${entry.name} still needs unbundled ${soname}`)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`bundled set is incomplete:\n${problems.join('\n')}`)
  }

  if (args.flags.has('verify-run')) {
    run(path.join(out, 'libnode.so'), ['-e', "console.log('node', process.version)"], {
      stdio: 'inherit',
    })
    run(path.join(out, 'libaria2c.so'), ['--version'], { stdio: 'inherit' })
  }

  process.stdout.write(
    `[native-libs] installed ${installed.length} entries into ${out}\n` +
      installed
        .map(
          (entry) =>
            `  ${entry.name}${entry.original ? ` (from ${entry.original})` : ''}`
        )
        .join('\n') +
      '\n'
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

export { EXECUTABLE_RENAMES }
