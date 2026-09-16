// Copies itk-vtk-viewer's dist assets (its JS bundle plus ~100MB of
// format-decoder wasm workers) from node_modules into public/ so Vite can
// serve them as plain static files. itk-vtk-viewer ships as a legacy
// global-script bundle rather than an ESM/CJS module (its own type
// declarations use `declare namespace itkVtkViewer`), so it's loaded via a
// <script> tag at runtime instead of `import`-ed -- see useItkVtkViewer.ts.
// Not vendored in git (see .gitignore): re-run via `npm run sync:itk-vtk-viewer`
// (also runs automatically before dev/build) whenever node_modules changes.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const src = path.join(rootDir, 'node_modules', 'itk-vtk-viewer', 'dist')
const dest = path.join(rootDir, 'public', 'itk-vtk-viewer')

if (!existsSync(src)) {
  console.error(`itk-vtk-viewer not found at ${src} -- run npm install first.`)
  process.exit(1)
}

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log(`Synced itk-vtk-viewer assets to ${dest}`)
