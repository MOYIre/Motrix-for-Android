#!/usr/bin/env node
// scripts/android/fetch-termux-runtime.mjs
//
// Materialise the Android arm64 runtime leaves the APK ships: the Node
// interpreter and the aria2 engine plus the shared libraries they link
// against. Termux is the only maintained source of bionic-linked builds for
// both.
//
// Filenames and digests come from the live apt index rather than a frozen URL:
// Termux prunes superseded versions from its pool, so a pinned URL rots while
// the index stays authoritative. Each package's `expectedVersionPrefix` in the
// manifest still fails the build loudly if a major version changes under us
// (a silent Node major jump would change the addon ABI).
//
//   node scripts/android/fetch-termux-runtime.mjs --out <dir>
//   node scripts/android/fetch-termux-runtime.mjs --out <dir> --from-prefix <prefix>
//
// `--from-prefix` skips the network entirely and copies the same leaves out of
// an existing Termux installation, which is how the packaging path is validated
// on device before a cloud build exists.
//
// Output layout mirrors a sysroot so later stages stay source-agnostic:
//   <out>/bin/node, <out>/bin/aria2c, <out>/lib/*.so

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
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

export async function readManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
}

/**
 * Parse a Debian `Packages` index into one record per package stanza. Only the
 * fields this script needs are kept.
 */
export function parsePackagesIndex(text) {
  const records = new Map()
  for (const stanza of text.split(/\n\s*\n/)) {
    const fields = new Map()
    for (const line of stanza.split('\n')) {
      const match = /^([A-Za-z0-9+-]+):\s*(.*)$/.exec(line)
      if (match) fields.set(match[1], match[2].trim())
    }
    const name = fields.get('Package')
    if (!name) continue
    records.set(name, {
      name,
      version: fields.get('Version') ?? '',
      filename: fields.get('Filename') ?? '',
      sha512: fields.get('SHA512') ?? '',
    })
  }
  return records
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Resolve the apt index from the first repository base that answers. */
export async function loadIndex(manifest) {
  const override = process.env.TERMUX_REPO_BASE
  const bases = override
    ? [override, ...manifest.index.bases]
    : manifest.index.bases
  const failures = []
  for (const base of bases) {
    try {
      const raw = await fetchBytes(`${base}/${manifest.index.path}`)
      const text = raw[0] === 0x1f ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
      return { base, index: parsePackagesIndex(text) }
    } catch (error) {
      failures.push(`${base}: ${error.message}`)
    }
  }
  throw new Error(`no Termux index reachable\n${failures.join('\n')}`)
}

export function resolvePackage(name, spec, index) {
  const record = index.get(name)
  if (!record) throw new Error(`Termux index has no package named ${name}`)
  if (!record.filename || !record.sha512) {
    throw new Error(`Termux index record for ${name} lacks Filename/SHA512`)
  }
  if (
    spec.expectedVersionPrefix &&
    !record.version.startsWith(spec.expectedVersionPrefix)
  ) {
    throw new Error(
      `Termux ${name} is ${record.version}, expected ${spec.expectedVersionPrefix}x; ` +
        'update scripts/android/termux-packages.json deliberately if this is intended'
    )
  }
  return record
}

// Minimal `ar` reader: a .deb is an ar archive whose `data.tar.*` member holds
// the payload. Reading the container in-process avoids depending on binutils
// being present in the packaging image.
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

export function extractArMember(buffer, wanted) {
  const MAGIC = Buffer.from('!<arch>\n', 'binary')
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an ar archive')
  }
  let offset = MAGIC.length
  while (offset + 60 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 60)
    const name = header.subarray(0, 16).toString('utf8').trim().replace(/\/+$/, '')
    const size = Number.parseInt(header.subarray(48, 58).toString('utf8').trim(), 10)
    const dataStart = offset + 60
    if (!Number.isFinite(size) || dataStart + size > buffer.length) {
      throw new Error(`corrupt ar member header at offset ${offset}`)
    }
    if (name === wanted) return buffer.subarray(dataStart, dataStart + size)
    offset = dataStart + size + (size % 2)
  }
  throw new Error(`ar member not found: ${wanted}`)
}

export function dataMemberFor(entries) {
  for (const candidate of ['data.tar.xz', 'data.tar.gz', 'data.tar.zst', 'data.tar']) {
    if (entries.includes(candidate)) return candidate
  }
  throw new Error(`no data member in deb: ${entries.join(', ')}`)
}

async function extractDeb(bytes, destDir, label) {
  const member = dataMemberFor(listArMembers(bytes))
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

/**
 * Locate a payload file inside an unpacked Termux package. Termux archives
 * carry the installation prefix (`data/data/com.termux/files/usr/...`) because
 * dpkg is rooted at it, so the payload is not directly under the extraction
 * directory.
 */
export function locateProvided(root, provided, exists = existsSync) {
  const candidates = [
    path.join(root, 'data/data/com.termux/files/usr', provided),
    path.join(root, 'usr', provided),
    path.join(root, provided),
  ]
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return undefined
}

async function copyFromPrefix(prefix, out, manifest) {
  const binaries = [
    ['bin/node', 'bin/node'],
    ['bin/aria2c', 'bin/aria2c'],
  ]
  for (const [from, to] of binaries) {
    const source = path.join(prefix, from)
    if (!existsSync(source)) throw new Error(`missing in prefix: ${source}`)
    await mkdir(path.dirname(path.join(out, to)), { recursive: true })
    await copyFile(source, path.join(out, to))
    await chmod(path.join(out, to), 0o755)
  }
  const wanted = new Set()
  for (const spec of Object.values(manifest.packages)) {
    for (const provided of spec.provides) {
      if (provided.startsWith('lib/')) wanted.add(provided.slice('lib/'.length))
    }
  }
  await mkdir(path.join(out, 'lib'), { recursive: true })
  for (const name of wanted) {
    const source = path.join(prefix, 'lib', name)
    if (!existsSync(source)) throw new Error(`missing library in prefix: ${source}`)
    await copyFile(source, path.join(out, 'lib', name))
  }
  return { mode: 'prefix', copied: wanted.size, versions: {} }
}

async function fetchFromDebs(out, manifest) {
  const { base, index } = await loadIndex(manifest)
  const unpackRoot = await mkdtemp(path.join(tmpdir(), 'motrix-termux-'))
  const versions = {}
  try {
    const resolved = []
    for (const [name, spec] of Object.entries(manifest.packages)) {
      const record = resolvePackage(name, spec, index)
      versions[name] = record.version
      resolved.push(record)
    }

    for (const record of resolved) {
      const bytes = await fetchBytes(`${base}/${record.filename}`)
      const digest = sha512Hex(bytes)
      if (digest !== record.sha512) {
        throw new Error(
          `digest mismatch for ${record.filename}\n  index ${record.sha512}\n  actual ${digest}`
        )
      }
      await extractDeb(bytes, unpackRoot, record.name)
      process.stdout.write(
        `[termux] ${record.filename} ${record.version} verified and unpacked\n`
      )
    }

    await mkdir(path.join(out, 'bin'), { recursive: true })
    await mkdir(path.join(out, 'lib'), { recursive: true })
    let copied = 0
    for (const spec of Object.values(manifest.packages)) {
      for (const provided of spec.provides) {
        const source = locateProvided(unpackRoot, provided)
        if (!source) throw new Error(`deb payload missing ${provided}`)
        const target = path.join(out, provided)
        await mkdir(path.dirname(target), { recursive: true })
        await copyFile(source, target)
        if (provided.startsWith('bin/')) await chmod(target, 0o755)
        copied += 1
      }
    }
    return { mode: 'deb', copied, versions }
  } finally {
    await rm(unpackRoot, { recursive: true, force: true })
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const out = args.out
  if (!out) throw new Error('--out <dir> is required')
  const manifest = await readManifest()
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  const result = args['from-prefix']
    ? await copyFromPrefix(path.resolve(args['from-prefix']), out, manifest)
    : await fetchFromDebs(out, manifest)
  const listing = await readdir(path.join(out, 'lib'))
  process.stdout.write(
    `[termux] runtime staged from ${result.mode}: ${result.copied} entries, ${listing.length} libraries in ${out}\n`
  )
  if (Object.keys(result.versions).length > 0) {
    process.stdout.write(
      `[termux] versions: ${Object.entries(result.versions)
        .map(([name, version]) => `${name}@${version}`)
        .join(', ')}\n`
    )
    await writeFile(
      path.join(out, 'motrix-termux-versions.json'),
      `${JSON.stringify(result.versions, null, 2)}\n`
    )
  }
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
