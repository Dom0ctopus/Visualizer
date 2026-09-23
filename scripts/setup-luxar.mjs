// Creates the optional Python environment the server uses to compile Luxar
// scenes (server/luxar/build_scene.py): server/.luxar-venv with
// server/luxar/requirements.txt installed. Uses uv when it's on PATH (much
// faster), otherwise python3.12+ -m venv + pip. Safe to re-run.
//
// torch is the big dependency (splat fitting). On Linux without an NVIDIA
// GPU the CPU-only wheel is tried first: the default PyPI wheel bundles
// ~3GB of CUDA libraries that such a machine can't use.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const venv = path.join(rootDir, 'server', '.luxar-venv')
const requirements = path.join(rootDir, 'server', 'luxar', 'requirements.txt')
const venvPython = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python')
const CPU_TORCH_INDEX = 'https://download.pytorch.org/whl/cpu'

function has(command, args = ['--version']) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0
}

function run(command, args, env = process.env) {
  console.log(`> ${command} ${args.join(' ')}`)
  return spawnSync(command, args, { stdio: 'inherit', env }).status === 0
}

function findPython() {
  for (const candidate of ['python3.13', 'python3.12', 'python3', 'python']) {
    if (!has(candidate)) continue
    try {
      const version = execFileSync(candidate, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']).toString().trim()
      const [major, minor] = version.split('.').map(Number)
      if (major === 3 && minor >= 12) return candidate
    } catch {
      // try the next one
    }
  }
  return null
}

const useUv = has('uv')
if (!existsSync(venvPython)) {
  if (useUv) {
    if (!run('uv', ['venv', '--python', '3.12', venv])) process.exit(1)
  } else {
    const python = findPython()
    if (!python) {
      console.error('Luxar needs Python 3.12 or newer. Install it (or uv: https://docs.astral.sh/uv/) and re-run.')
      process.exit(1)
    }
    if (!run(python, ['-m', 'venv', venv])) process.exit(1)
  }
}

const install = (extra) =>
  useUv
    ? run('uv', ['pip', 'install', '-r', requirements, ...extra], { ...process.env, VIRTUAL_ENV: venv })
    : run(venvPython, ['-m', 'pip', 'install', '-r', requirements, ...extra])

const wantCpuTorch = process.platform === 'linux' && !has('nvidia-smi', ['-L'])
let ok = false
if (wantCpuTorch) {
  const extra = useUv ? ['--extra-index-url', CPU_TORCH_INDEX, '--index-strategy', 'unsafe-best-match'] : ['--extra-index-url', CPU_TORCH_INDEX]
  ok = install(extra)
  if (!ok) console.warn('CPU-only torch install failed; falling back to the default PyPI wheel.')
}
if (!ok) ok = install([])
if (!ok) process.exit(1)

execFileSync(venvPython, ['-c', 'import luxar, torch; print("luxar", luxar.__version__, "| torch", torch.__version__, "| device:", "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu"))'], { stdio: 'inherit' })
console.log('Luxar is ready. The server picks it up automatically (no restart needed).')
