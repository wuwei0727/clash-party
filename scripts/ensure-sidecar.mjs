import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cwd = path.resolve(__dirname, '..')
const sidecarDir = path.join(cwd, 'extra', 'sidecar')

const requiredFiles = [
  'mihomo.exe',
  'mihomo-alpha.exe',
  'mihomo-smart.exe',
  'sysproxy.win32-x64-msvc.node'
]

const fallbackRoots = [
  path.join(cwd, 'dist'),
  path.join(cwd, 'dist-fresh'),
  path.join(cwd, 'dist-fresh2'),
  path.join(cwd, 'dist-fresh3'),
  path.join(cwd, 'dist-installer'),
  path.join(cwd, 'dist-installer-1.9.6'),
  path.join(cwd, 'dist-installer-1.9.6-latest'),
  path.join(cwd, 'dist-installer-1.9.6-latest-95fba15'),
  path.join(cwd, 'dist-installer-1.9.6-latest-95fba15b'),
  path.join(cwd, 'dist-installer-1.9.6-latest-d482ca2'),
  path.join(cwd, 'dist-installer-1.9.6-latest-d482ca2b'),
  path.join(cwd, 'dist-installer-final'),
  path.join(cwd, 'dist-installer-final2'),
  path.join(cwd, 'dist-installer-nsis'),
  path.join(cwd, 'dist-installer-nsis2'),
  path.join(cwd, 'dist-release')
]

function walk(dir, fileName) {
  if (!fs.existsSync(dir)) return null

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
    if (entry.isDirectory()) {
      const nested = walk(fullPath, fileName)
      if (nested) return nested
    }
  }

  return null
}

fs.mkdirSync(sidecarDir, { recursive: true })

for (const fileName of requiredFiles) {
  const targetPath = path.join(sidecarDir, fileName)
  if (fs.existsSync(targetPath)) {
    continue
  }

  let sourcePath = null
  for (const root of fallbackRoots) {
    sourcePath = walk(root, fileName)
    if (sourcePath) break
  }

  if (!sourcePath) {
    throw new Error(
      `Missing required sidecar file: ${fileName}. Please run "pnpm run prepare" in a network-ready environment first.`
    )
  }

  fs.copyFileSync(sourcePath, targetPath)
  console.log(`[ensure-sidecar] restored ${fileName} from ${sourcePath}`)
}

console.log('[ensure-sidecar] sidecar files are ready')
