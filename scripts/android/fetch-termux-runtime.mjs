#!/usr/bin/env node
// scripts/android/fetch-termux-runtime.mjs
//
// Materialise the Android arm64 runtime leaves the APK ships: the Node
// interpreter and the aria2 engine plus the shared libraries they link
// against. Termux is the only maintained source of bionic-linked builds for
// both, so this fetches pinned .deb packages from the Termux apt pool and
// verifies every digest before extraction.
//
//   node scripts/android/fetch-termux-runtime.mjs --out <dir>
//   node scripts/android/fetch-termux-runtime.mjs --out <dir> --from-prefix <prefix>
//
// `--from-prefix` skips the network entirely and copies the same leaves out of
// an existing Termux installation, which is how the packaging path is
// validated on device before a cloud build exists.
//
// Output layout mirrors a sysroot so later stages stay source-agnostic:
//   <out>/bin/node, <out>/bin/aria2c, <out>/lib/*.so

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const MANIFEST_PATH = path.join(SCRIPT_DIR, 'termux-packages.json')

const DEFAULT_REPOS = [
  'https://packages.termux.dev/apt/termux-main',
  'https://is.mirror.flokinet.net/termux/termux-main',
]

export function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${token} requires a value`)
    }
    out[token.slice(2)] = value
    index += 1
  }
  return out
}

export function sha512Hex(bytes) {
  return createHash('sha512').update(bytes).digest('hex')
}

// Minimal `ar` reader: a .deb is an ar archive whose `data.tar.*` member holds
// the payload. Reading the container in-process avoids depending on binutils
// being present in the Android packaging container.
export function extractArMember(buffer, wanted) {
  const MAGIC = Buffer.from('!<arch>\n', 'binary')
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an ar archive')
  }
  let offset = MAGIC.length
  while (offset + 60 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 60)
    const name = header.subarray(0, 16).toString('utf8').trim()
    const size = Number.parseInt(header.subarray(48, 58).toString('utf8').trim(), 10)
    const dataStart = offset + 60
    if (!Number.isFinite(size) || dataStart + size > buffer.length) {
      throw new Error(`corrupt ar member header at offset ${offset}`)
    }
    // Names in GNU ar end with '/' and may be terminated by spaces.
    const normalized = name.replace(/\/+$/, '')
    if (normalized === wanted) {
      return buffer.subarray(dataStart, dataStart + size)
    }
    offset = dataStart + size + (size % 2)
  }
  throw new Error(`ar member not found: ${wanted}`)
}

export function dataMemberFor(entries) {
  const preferred = ['data.tar.xz', 'data.tar.gz', 'data.tar.zst', 'data.tar']
  for (const candidate of preferred) if (entries.includes(candidate)) return candidate
  throw new Error(`no data member in deb: ${entries.join(', ')}`)
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function extractDeb(bytes, destDir, label) {
  const members = listArMembers(bytes)
  const member = dataMemberFor(members)
  const payload = extractArMember(bytes, member)
  const scratch = await mkdtemp(path.join(tmpdir(), `motrix-deb-${label}-`))
  try {
    const archive = path.join(scratch, member)
    await writeFile(archive, payload)
    const result = spawnSync('tar', ['-x', '-f', archive, '-C', destDir], {
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`tar extraction failed for ${label} (${result.status})`)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export function listArMembers(buffer) {
  const MAGIC = Buffer.from('!<arch>\n', 'binary')
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an ar archive')
  }
  const names = []
  let offset = MAGIC.length
  while (offset + 60 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 60)
    const name = header.subarray(0, 16).toString('utf8').trim().replace(/\/+$/, '')
    const size = Number.parseInt(header.subarray(48, 58).toString('utf8').trim(), 10)
    if (!Number.isFinite(size)) throw new Error('corrupt ar archive')
    names.push(name)
    offset = offset + 60 + size + (size % 2)
  }
  return names
}

async function fetchFromRepos(entry, label) {
  const override = process.env.TERMUX_REPO_BASE
  const repos = override ? [override, ...DEFAULT_REPOS] : DEFAULT_REPOS
  const failures = []
  for (const repo of repos) {
    const url = `${repo}/${entry.path}`
    try {
      const bytes = await download(url)
      const digest = sha512Hex(bytes)
      if (digest !== entry.sha512) {
        throw new Error(
          `digest mismatch for ${entry.filename}\n  expected ${entry.sha512}\n  actual   ${digest}`
        )
      }
      return bytes
    } catch (error) {
      failures.push(`${url}: ${error.message}`)
    }
  }
  throw new Error(
    `unable to fetch ${label} (${entry.filename}) from any Termux repo\n${failures.join('\n')}`
  )
}

async function copyFromPrefix(prefix, out) {
  const sources = [
    ['bin/node', 'bin/node'],
    ['bin/aria2c', 'bin/aria2c'],
  ]
  for (const [from, to] of sources) {
    const source = path.join(prefix, from)
    if (!existsSync(source)) throw new Error(`missing in prefix: ${source}`)
    await mkdir(path.dirname(path.join(out, to)), { recursive: true })
    await copyFile(source, path.join(out, to))
    await chmod(path.join(out, to), 0o755)
  }
  // Copy every library the manifest knows about; later stages keep only the
  // ones the binaries actually reference.
  const libDir = path.join(prefix, 'lib')
  const wanted = new Set()
  for (const entry of Object.values(
    JSON.parse(await readFile(MANIFEST_PATH, 'utf8')).packages
  )) {
    for (const provided of entry.provides) {
      if (provided.startsWith('lib/')) wanted.add(provided.slice('lib/'.length))
    }
  }
  await mkdir(path.join(out, 'lib'), { recursive: true })
  for (const name of wanted) {
    const source = path.join(libDir, name)
    if (!existsSync(source)) {
      throw new Error(`missing library in prefix: ${source}`)
    }
    await copyFile(source, path.join(out, 'lib', name))
  }
  return { mode: 'prefix', copied: wanted.size }
}

async function fetchFromDebs(out) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const unpackRoot = await mkdtemp(path.join(tmpdir(), 'motrix-termux-'))
  try {
    for (const [label, entry] of Object.entries(manifest.packages)) {
      const bytes = await fetchFromRepos(entry, label)
      await extractDeb(bytes, unpackRoot, label)
      process.stdout.write(
        `[termux] ${entry.filename} verified (${bytes.length} bytes) and unpacked\n`
      )
    }
    const copied = []
    await mkdir(path.join(out, 'bin'), { recursive: true })
    await mkdir(path.join(out, 'lib'), { recursive: true })
    for (const entry of Object.values(manifest.packages)) {
      for (const provided of entry.provides) {
        const source = path.join(unpackRoot, provided)
        if (!existsSync(source)) {
          throw new Error(`deb payload missing ${provided}`)
        }
        const target = path.join(out, provided)
        await copyFile(source, target)
        if (provided.startsWith('bin/')) await chmod(target, 0o755)
        copied.push(provided)
      }
    }
    return { mode: 'deb', copied: copied.length }
  } finally {
    await rm(unpackRoot, { recursive: true, force: true })
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const out = args.out
  if (!out) throw new Error('--out <dir> is required')
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  const result = args['from-prefix']
    ? await copyFromPrefix(path.resolve(args['from-prefix']), out)
    : await fetchFromDebs(out)
  const listing = await readdir(path.join(out, 'lib'))
  process.stdout.write(
    `[termux] runtime staged from ${result.mode}: ${result.copied} entries, ${listing.length} libraries in ${out}\n`
  )
  return 0
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}

export { REPOSITORY_ROOT }
