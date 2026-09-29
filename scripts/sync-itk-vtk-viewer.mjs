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

// Patches to vtk.js's volume renderer inside the bundle. vtk.js freezes its
// objects, so its shaders can't be amended at runtime; these edit the
// bundle's source instead. Each must match exactly as often as expected --
// if an itk-vtk-viewer upgrade changes the code, the sync warns and skips it.
//
// To rule them in or out when chasing a rendering problem, turn some off by
// id and restart the dev server (the sync runs before it starts):
//   ITK_VIEWER_PATCHES_OFF=all npm run dev:all
//   ITK_VIEWER_PATCHES_OFF=loop-cap,pixel-ratio npm run dev:all
const patchesOff = new Set((process.env.ITK_VIEWER_PATCHES_OFF ?? '').split(',').map((id) => id.trim()).filter(Boolean))
const patches = [
  {
    // Nearest-voxel label sampling. vtk.js packs the CT and the label image
    // into one 3D texture and samples it trilinearly, so at a boundary
    // between label 0 and label 4 the label reads 1, 2 and 3 on the way --
    // and a hidden or unfocused segment keeps a shell in whatever opacity and
    // color those other labels have. So the ray march's samples re-read the
    // label (proportional) component at the nearest texel center, keeping
    // labels exact while the CT stays smooth. Only those samples: the
    // lighting gradients' neighbor reads don't use the label, and doubling
    // them made every sample twice as expensive -- which counts in search
    // focus, where transparent tissue lets rays run the whole volume.
    id: 'label-function',
    name: 'nearest-voxel label sampling (function)',
    skipped: 'hidden/unfocused segments will leave faint shells in the voxel render',
    find: '// End of Webgl1 specific code\\n//=======================================================================\\n#endif\\n',
    replace: (match) =>
      match +
      [
        '',
        'vec4 getLabeledTextureValue(vec3 pos)',
        '{',
        '  vec4 tmp = getTextureValue(pos);',
        '#if __VERSION__ == 300 && defined(vtkIndependentComponentsOn)',
        '  vec3 labelTexel = (floor(pos * vec3(textureSize(texture1, 0))) + 0.5) / vec3(textureSize(texture1, 0));',
        '  #if vtkNumComponents == 2 && defined(vtkComponent1Proportional)',
        '    tmp.g = texture(texture1, labelTexel).g;',
        '    tmp.a = tmp.g;',
        '  #elif vtkNumComponents == 3 && defined(vtkComponent2Proportional)',
        '    tmp.b = texture(texture1, labelTexel).b;',
        '  #elif vtkNumComponents == 4 && defined(vtkComponent3Proportional)',
        '    tmp.a = texture(texture1, labelTexel).a;',
        '  #endif',
        '#endif',
        '  return tmp;',
        '}',
        ''
      ].join('\\n')
  },
  {
    id: 'label-march',
    name: 'nearest-voxel label sampling (ray march)',
    skipped: 'hidden/unfocused segments will leave faint shells in the voxel render',
    find: 'tValue = getTextureValue(posIS);',
    expected: 9,
    // Calls the function above, which must be there.
    requires: 'label-function',
    replace: () => 'tValue = getLabeledTextureValue(posIS);'
  },
  {
    // A stable shader. vtk.js writes the ray-march loop's iteration cap --
    // volume diagonal / sample distance -- into the fragment shader source,
    // so every change of resolution level (itk-vtk-viewer streams finer
    // ones in), label-image extent or interactive sample distance makes a
    // new shader, and each new one is compiled from scratch while the page
    // waits: seconds apiece on a real GPU, and they came in bursts --
    // "page unresponsive". The loop exits at the ray's end anyway, so the
    // cap only needs to be big enough: a power of two of at least 16384
    // gives one shader for practically every volume.
    id: 'loop-cap',
    name: 'fixed ray-march loop cap',
    skipped: 'the voxel render will recompile its shader (freezing the page) whenever the resolution changes',
    find: /"\/\/VTK::MaximumSamplesValue","".concat\(Math\.ceil\((\w+)\)\)/g,
    replace: (_match, samples) =>
      `"//VTK::MaximumSamplesValue","".concat(Math.max(16384,Math.pow(2,Math.ceil(Math.log2(Math.max(1,${samples}))))))`
  },
  {
    // Skip invisible samples. For every sample along a ray the shader first
    // computes the lighting gradient -- more reads of the volume plus the
    // shading math -- and only then its opacity. That opacity has a cheap
    // upper bound (the gradient factor is clamped to at most gomax0):
    //  - with a label image,
    //      gomax0 * mix0 * ctOpacity(CT) * mix(labelOpacity, 1, 1 - blend);
    //    when that is 0 the sample adds exactly nothing (the ray march adds
    //    rgb * alpha and alpha): air around the specimen, hidden segments,
    //    and everything outside a search focus at full strength. Merely
    //    faint samples (a partial focus's faded tissue) are kept -- together
    //    they make the visible ghost.
    //  - with the volume alone, gomax0 * ctOpacity(CT); vtk.js itself
    //    discards a sample whose opacity is below EPSILON (after computing
    //    its gradient), so a bound below EPSILON returns the same result
    //    before the gradient. With volume scattering on, that also skips the
    //    gradient those samples' shadow rays would have been cast from.
    id: 'skip-invisible',
    name: 'skip invisible samples',
    skipped: 'invisible samples will still pay for lighting (slower voxel frames)',
    find: '#else\\n  // compute the normal and gradient magnitude if needed\\n  // We compute it as a vec4 if possible otherwise a mat4\\n  //\\n  vec4 goFactor = vec4(1.0,1.0,1.0,1.0);\\n',
    replace: (match) =>
      match +
      [
        '  #if defined(vtkIndependentComponentsOn) && vtkNumComponents == 2 && defined(vtkComponent1Proportional) && !defined(vtkComponent0Proportional)',
        '    #if defined(vtkGradientOpacityOn)',
        '      float opacityBound = gomax0;',
        '    #else',
        '      float opacityBound = 1.0;',
        '    #endif',
        '    opacityBound *= mix0 * texture2D(otexture, vec2(tValue.r * oscale0 + oshift0, height0)).r;',
        '    opacityBound *= mix(texture2D(otexture, vec2(tValue.g * oscale1 + oshift1, height1)).r, 1.0, 1.0 - mix1);',
        '    if (opacityBound <= 0.0) return vec4(0.0);',
        '  #endif',
        '  #if vtkNumComponents == 1',
        '    #if defined(vtkGradientOpacityOn)',
        '      float opacityBound1 = gomax0;',
        '    #else',
        '      float opacityBound1 = 1.0;',
        '    #endif',
        '    opacityBound1 *= texture2D(otexture, vec2(tValue.r * oscale0 + oshift0, 0.5)).r;',
        '    if (opacityBound1 < EPSILON) return vec4(0.0);',
        '  #endif',
        ''
      ].join('\\n')
  },
  {
    // Null voxels are empty space. In a masked scan everything outside the
    // specimen is the volume's minimum value (0), and the opacity curve's
    // leftmost point applies to it too: raise that point and the whole
    // empty box turns into semi-opaque haze, every sample of it paying for
    // lighting (and, with volume scattering, a shadow ray) -- the heaviest
    // frame the renderer can draw. So a sample exactly at the volume's
    // minimum is transparent whatever the curve says; everything above it
    // follows the curve as before. Four parts: this hands the shader the
    // minimum (of component 0, the volume) in texture units, the next one
    // declares it, and the last two skip such samples along the ray and in
    // scattering's shadow rays.
    id: 'null-voxels',
    name: 'null voxels transparent (minimum value)',
    skipped: 'empty space at the minimum value follows the opacity curve (and pays for lighting) like tissue',
    find: 'o.setUniformf("oshift".concat(u),m),o.setUniformf("oscale".concat(u),h);',
    replace: (match) =>
      match +
      'try{var vtkNullRange=r.getMapper().getInputData().getPointData().getScalars().getRange(u);o.setUniformf("vtkNull".concat(u),(vtkNullRange[0]-i.offset[u])/(i.scale[u]||1))}catch(vtkNullError){}'
  },
  {
    id: 'null-voxels-declare',
    name: 'null voxels transparent (declaration)',
    skipped: 'empty space at the minimum value follows the opacity curve like tissue',
    requires: 'null-voxels',
    find: '// End of Webgl1 specific code\\n//=======================================================================\\n#endif\\n',
    replace: (match) => match + '\\n// The volume\'s minimum value in texture units (null voxels; see the sync script).\\nuniform float vtkNull0;\\n'
  },
  {
    id: 'null-voxels-samples',
    name: 'null voxels transparent (ray march)',
    skipped: 'empty space at the minimum value follows the opacity curve like tissue',
    requires: 'null-voxels-declare',
    find: '#else\\n  // compute the normal and gradient magnitude if needed\\n  // We compute it as a vec4 if possible otherwise a mat4\\n  //\\n  vec4 goFactor = vec4(1.0,1.0,1.0,1.0);\\n',
    replace: (match) =>
      match +
      [
        '  #if vtkNumComponents == 1 || (vtkNumComponents == 2 && defined(vtkIndependentComponentsOn) && defined(vtkComponent1Proportional))',
        '    if (tValue.r <= vtkNull0 + 1.0e-6) return vec4(0.0);',
        '  #endif',
        ''
      ].join('\\n')
  },
  {
    id: 'null-voxels-shadows',
    name: 'null voxels transparent (scattering shadow rays)',
    skipped: 'empty space at the minimum value still casts scattering shadows',
    requires: 'null-voxels-declare',
    find: '    scalar = getTextureValue(posIS);\\n    opacity = texture2D(otexture, vec2(scalar.r * oscale0 + oshift0, 0.5)).r;\\n',
    replace: (match) =>
      match + ['    #if vtkNumComponents == 1', '      if (scalar.r <= vtkNull0 + 1.0e-6) opacity = 0.0;', '    #endif', ''].join('\\n')
  },
  {
    // The voxel render at one ray per CSS pixel, not per device pixel. Its
    // canvas is sized devicePixelRatio times the pane, so a Retina display
    // cast 4x the rays for a soft volume image that doesn't look sharper
    // for it -- and with search focus making tissue transparent, every ray
    // crosses the whole volume: frames took so long that macOS reset the
    // GPU, and after a few resets Chrome disabled WebGL for the page.
    id: 'pixel-ratio',
    name: 'voxel render pixel ratio capped at 1',
    skipped: 'the voxel render will cast a ray per device pixel (4x the GPU work on Retina displays)',
    find: 'var r=window.devicePixelRatio||1,o=Math.max(10,Math.floor(r*n.width)),i=Math.max(10,Math.floor(r*n.height));t._openGLRenderWindow.setSize(o,i)',
    expected: 2,
    replace: () =>
      'var r=Math.min(window.devicePixelRatio||1,1),o=Math.max(10,Math.floor(r*n.width)),i=Math.max(10,Math.floor(r*n.height));t._openGLRenderWindow.setSize(o,i)'
  }
]

const bundle = path.join(dest, 'itkVtkViewer.js')
let code = readFileSync(bundle, 'utf8')
const applied = new Set()
for (const patch of patches) {
  if (patchesOff.has('all') || patchesOff.has(patch.id)) {
    console.warn(`itk-vtk-viewer patch "${patch.id}" turned off (ITK_VIEWER_PATCHES_OFF); ${patch.skipped}.`)
    continue
  }
  if (patch.requires && !applied.has(patch.requires)) {
    console.warn(`WARNING: itk-vtk-viewer patch "${patch.name}" skipped (needs "${patch.requires}"); ${patch.skipped}.`)
    continue
  }
  const expected = patch.expected ?? 1
  const matches = typeof patch.find === 'string' ? code.split(patch.find).length - 1 : [...code.matchAll(patch.find)].length
  if (matches === expected) {
    code = typeof patch.find === 'string' ? code.replaceAll(patch.find, patch.replace) : code.replace(patch.find, patch.replace)
    applied.add(patch.id)
    console.log(`Patched itk-vtk-viewer: ${patch.name} (${patch.id})`)
  } else {
    console.warn(`WARNING: itk-vtk-viewer patch "${patch.name}" matched ${matches} times, expected ${expected} -- skipped; ${patch.skipped}.`)
  }
}
writeFileSync(bundle, code)
