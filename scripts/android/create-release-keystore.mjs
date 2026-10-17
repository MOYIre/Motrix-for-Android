#!/usr/bin/env node
// scripts/android/create-release-keystore.mjs
//
// Create the Android release signing key once and print the values a cloud
// build needs. The key is intentionally NOT committed to the repository:
// it belongs in GitHub Actions secrets, where only the encrypted store keeps
// it. This script is the pairing half of the workflow's signing step.
//
//   node scripts/android/create-release-keystore.mjs --out <keystore.jks>
//
// Prints the keystore (base64), password, alias and the exact `gh secret set`
// commands to configure the repository. Keep the printed values private; they
// are the signing identity of every APK the project publishes.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..', '..')

function parseArgs(argv) {
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

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status})`)
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const out = args.out
  if (!out) throw new Error('--out <keystore.jks> is required')
  if (existsSync(out)) throw new Error(`refusing to overwrite existing key: ${out}`)
  if (process.platform !== 'linux' && process.platform !== 'android') {
    throw new Error('keytool is expected to come from a JDK; run this on Termux or a Linux host')
  }

  const password = randomBytes(18).toString('base64url')
  const alias = 'motrix-release'
  const store = path.resolve(REPOSITORY_ROOT, out)
  await mkdir(path.dirname(store), { recursive: true })

  run('keytool', [
    '-genkeypair',
    '-keystore', store,
    '-alias', alias,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-storepass', password,
    '-keypass', password,
    '-dname', 'CN=Motrix for Android, OU=Automated Builds, O=Motrix, C=CN',
    '-storetype', 'JKS',
  ])

  const bytes = await readFile(store)
  const base64 = bytes.toString('base64')

  // With --values-dir the values are written to files so they can be fed to
  // `gh secret set --body-file` without ever appearing on a command line.
  if (args['values-dir']) {
    const valuesDir = path.resolve(REPOSITORY_ROOT, args['values-dir'])
    await mkdir(valuesDir, { recursive: true })
    await writeFile(path.join(valuesDir, 'ANDROID_KEYSTORE_BASE64'), base64)
    await writeFile(path.join(valuesDir, 'ANDROID_KEYSTORE_PASSWORD'), password)
    await writeFile(path.join(valuesDir, 'ANDROID_KEY_PASSWORD'), password)
    await writeFile(path.join(valuesDir, 'ANDROID_KEY_ALIAS'), alias)
  }

  process.stdout.write(
    `\n[keystore] created ${store}\n` +
      `[keystore] alias:      ${alias}\n` +
      `[keystore] password:   ${password}\n\n` +
      `Configure the repository once (values are encrypted at rest):\n\n` +
      `gh secret set ANDROID_KEYSTORE_BASE64 --body-file '${path.join(
        path.resolve(REPOSITORY_ROOT, args['values-dir'] ?? '.'),
        'ANDROID_KEYSTORE_BASE64'
      )}'\n` +
      `gh secret set ANDROID_KEYSTORE_PASSWORD --body-file '${path.join(
        path.resolve(REPOSITORY_ROOT, args['values-dir'] ?? '.'),
        'ANDROID_KEYSTORE_PASSWORD'
      )}'\n` +
      `gh secret set ANDROID_KEY_PASSWORD --body-file '${path.join(
        path.resolve(REPOSITORY_ROOT, args['values-dir'] ?? '.'),
        'ANDROID_KEY_PASSWORD'
      )}'\n` +
      `gh secret set ANDROID_KEY_ALIAS --body-file '${path.join(
        path.resolve(REPOSITORY_ROOT, args['values-dir'] ?? '.'),
        'ANDROID_KEY_ALIAS'
      )}'\n\n` +
      `Then remove the local material: rm -rf ${store} ${path.resolve(
        REPOSITORY_ROOT,
        args['values-dir'] ?? ''
      )}\n`
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
