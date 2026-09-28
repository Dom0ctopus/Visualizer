// Copies itk-vtk-viewer's dist assets (its JS bundle plus ~100MB of
// format-decoder wasm workers) from node_modules into public/ so Vite can
// serve them as plain static files. itk-vtk-viewer ships as a legacy
// global-script bundle rather than an ESM/CJS module (its own type
// declarations use `declare namespace itkVtkViewer`), so it's loaded via a
// <script> tag at runtime instead of `import`-ed -- see useItkVtkViewer.ts.
// Not vendored in git (see .gitignore): re-run via `npm run sync:itk-vtk-viewer`
// (also runs automatically before dev/build) whenever node_modules changes.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// Nearest-voxel label sampling in the voxel render. vtk.js packs the CT and
// the label image into one 3D texture and samples it trilinearly, so at a
// boundary between label 0 and label 4 the label reads 1, 2 and 3 on the way
// -- and a hidden or unfocused segment keeps a shell in whatever opacity and
// color those other labels have. Re-reading the label (proportional)
// component at the nearest texel center keeps labels exact while the CT stays
// smooth. vtk.js freezes its objects, so the shader can't be amended at
// runtime; this edits the volume fragment shader template (a string in the
// bundle) instead.
const TEXTURE_READ = 'vec4 tmp = texture(texture1, pos);\\n'
const NEAREST_LABEL = [
  '#if defined(vtkIndependentComponentsOn)',
  '  #if vtkNumComponents == 2 && defined(vtkComponent1Proportional)',
  '    tmp.g = texture(texture1, (floor(pos * vec3(textureSize(texture1, 0))) + 0.5) / vec3(textureSize(texture1, 0))).g;',
  '  #elif vtkNumComponents == 3 && defined(vtkComponent2Proportional)',
  '    tmp.b = texture(texture1, (floor(pos * vec3(textureSize(texture1, 0))) + 0.5) / vec3(textureSize(texture1, 0))).b;',
  '  #elif vtkNumComponents == 4 && defined(vtkComponent3Proportional)',
  '    tmp.a = texture(texture1, (floor(pos * vec3(textureSize(texture1, 0))) + 0.5) / vec3(textureSize(texture1, 0))).a;',
  '  #endif',
  '#endif',
  ''
].join('\\n')
const bundle = path.join(dest, 'itkVtkViewer.js')
const code = readFileSync(bundle, 'utf8')
const reads = code.split(TEXTURE_READ).length - 1
if (reads === 1) {
  writeFileSync(bundle, code.replace(TEXTURE_READ, TEXTURE_READ + NEAREST_LABEL))
  console.log('Patched the volume shader for nearest-voxel label sampling')
} else {
  console.warn(
    `WARNING: expected one volume-shader texture read in ${bundle}, found ${reads} -- ` +
      'not patching; hidden/unfocused segments will leave faint shells in the voxel render.'
  )
}
