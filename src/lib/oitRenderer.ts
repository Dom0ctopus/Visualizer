import * as THREE from 'three'

/**
 * Order-independent transparency for the Basic mesh viewer (weighted
 * blended OIT, McGuire & Bavoil 2013).
 *
 * three.js draws transparent meshes back to front, sorted by each mesh's
 * bounding-sphere center. Segment surfaces overlap and nest, so while the
 * view rotates the sort order of overlapping segments flips and they pop in
 * front of / behind each other. Here the result doesn't depend on draw
 * order:
 *
 *   1. Opaque meshes render into an offscreen target, keeping its depth.
 *   2. Every transparent mesh renders once into a two-attachment target,
 *      depth-tested by hand against (1): attachment 0 accumulates
 *      premultiplied, depth-weighted color (additively) and, in its alpha,
 *      the product of (1 - alpha) -- how much of the background shows
 *      through -- via a separate alpha blend; attachment 1 accumulates the
 *      weights, to normalize the color.
 *   3. A full-screen pass composites the average transparent color over (1)
 *      in proportion to the coverage.
 *
 * With no transparent mesh visible it renders straight to the screen, as
 * before.
 */

const OIT_KEY = 'oit-v1'

interface OitUniforms {
  tOpaqueDepth: { value: THREE.Texture | null }
  uOitResolution: { value: THREE.Vector2 }
  uOitDepthScale: { value: number }
}

/** The transparent-pass version of a mesh's material: the same lit
 *  standard/physical shading, writing to the OIT targets. Kept on the mesh
 *  and rebuilt only when the finish (material class) changes. */
function oitMaterialFor(mesh: THREE.Mesh, uniforms: OitUniforms): THREE.MeshStandardMaterial {
  const source = mesh.material as THREE.MeshStandardMaterial
  const data = mesh.userData as { oitMaterial?: THREE.MeshStandardMaterial }
  let material = data.oitMaterial
  if (!material || material.type !== source.type) {
    material?.dispose()
    material = source.clone()
    material.transparent = true
    material.depthTest = false // done in the shader, against the opaque pass
    material.depthWrite = false
    material.blending = THREE.CustomBlending
    material.blendEquation = THREE.AddEquation
    material.blendSrc = THREE.OneFactor
    material.blendDst = THREE.OneFactor
    material.blendEquationAlpha = THREE.AddEquation
    material.blendSrcAlpha = THREE.ZeroFactor
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          `uniform sampler2D tOpaqueDepth;
uniform vec2 uOitResolution;
uniform float uOitDepthScale;
layout(location = 1) out highp vec4 oitWeight;
void main() {
  if (gl_FragCoord.z > texture2D(tOpaqueDepth, gl_FragCoord.xy / uOitResolution).x) discard;`
        )
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
  float oitAlpha = clamp(gl_FragColor.a, 0.0, 1.0);
  // Nearer surfaces weigh more (McGuire & Bavoil, eq. 7, in view distance
  // relative to the scene's size).
  float oitDepth = length(vViewPosition) / uOitDepthScale;
  float oitW = oitAlpha * clamp(0.03 / (1e-5 + pow(oitDepth * 0.5, 4.0)), 1e-2, 3e3);
  oitWeight = vec4(oitW, 0.0, 0.0, 0.0);
  gl_FragColor = vec4(gl_FragColor.rgb * oitW, oitAlpha);`
        )
    }
    material.customProgramCacheKey = () => `${OIT_KEY}-${source.type}`
    data.oitMaterial = material
  }
  material.color.copy(source.color)
  material.opacity = source.opacity
  material.side = source.side
  return material
}

export function disposeOitMaterial(mesh: THREE.Mesh): void {
  ;(mesh.userData as { oitMaterial?: THREE.Material }).oitMaterial?.dispose()
}

export class OitRenderer {
  private readonly opaque: THREE.WebGLRenderTarget
  private readonly accum: THREE.WebGLRenderTarget
  private readonly uniforms: OitUniforms
  private readonly composite: THREE.Mesh
  private readonly compositeScene = new THREE.Scene()
  private readonly compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  private readonly renderer: THREE.WebGLRenderer

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    this.opaque = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType)
    })
    this.accum = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, count: 2, depthBuffer: false })
    this.uniforms = {
      tOpaqueDepth: { value: this.opaque.depthTexture },
      uOitResolution: { value: size.clone() },
      uOitDepthScale: { value: 1 }
    }
    this.composite = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          tOpaque: { value: this.opaque.texture },
          tAccum: { value: this.accum.textures[0] },
          tWeight: { value: this.accum.textures[1] }
        },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `
uniform sampler2D tOpaque;
uniform sampler2D tAccum;
uniform sampler2D tWeight;
varying vec2 vUv;
void main() {
  vec3 opaque = texture2D(tOpaque, vUv).rgb;
  vec4 accum = texture2D(tAccum, vUv);
  float weight = texture2D(tWeight, vUv).r;
  float reveal = accum.a;
  vec3 transparent = accum.rgb / max(weight, 1e-5);
  gl_FragColor = vec4(mix(transparent, opaque, reveal), 1.0);
  #include <colorspace_fragment>
}`,
        depthTest: false,
        depthWrite: false
      })
    )
    this.composite.frustumCulled = false
    this.compositeScene.add(this.composite)
  }

  setSize(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    this.opaque.setSize(size.x, size.y)
    this.accum.setSize(size.x, size.y)
    this.uniforms.uOitResolution.value.copy(size)
  }

  /** Scene size for the depth weighting (roughly the viewing distance). */
  setDepthScale(scale: number): void {
    this.uniforms.uOitDepthScale.value = Math.max(scale, 1e-6)
  }

  render(scene: THREE.Scene, camera: THREE.Camera, meshes: Iterable<THREE.Mesh>): void {
    const transparent: THREE.Mesh[] = []
    const opaque: THREE.Mesh[] = []
    for (const mesh of meshes) {
      if (!mesh.visible) continue
      ;((mesh.material as THREE.Material).transparent ? transparent : opaque).push(mesh)
    }
    const renderer = this.renderer
    if (transparent.length === 0) {
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
      return
    }
    const clearColor = renderer.getClearColor(new THREE.Color())
    const clearAlpha = renderer.getClearAlpha()
    const swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = []
    try {
      // 1. Opaque surfaces, with depth.
      for (const mesh of transparent) mesh.visible = false
      renderer.setRenderTarget(this.opaque)
      renderer.render(scene, camera)
      for (const mesh of transparent) mesh.visible = true

      // 2. Transparent surfaces, order-independently.
      for (const mesh of opaque) mesh.visible = false
      for (const mesh of transparent) {
        swapped.push([mesh, mesh.material])
        mesh.material = oitMaterialFor(mesh, this.uniforms)
      }
      renderer.setClearColor(0x000000, 1) // color 0, revealage 1, weight 0
      renderer.setRenderTarget(this.accum)
      renderer.render(scene, camera)

      // 3. Composite.
      renderer.setRenderTarget(null)
      renderer.render(this.compositeScene, this.compositeCamera)
    } finally {
      for (const [mesh, material] of swapped) mesh.material = material
      for (const mesh of opaque) mesh.visible = true
      renderer.setClearColor(clearColor, clearAlpha)
      renderer.setRenderTarget(null)
    }
  }

  dispose(): void {
    this.opaque.depthTexture?.dispose()
    this.opaque.dispose()
    this.accum.dispose()
    this.composite.geometry.dispose()
    ;(this.composite.material as THREE.Material).dispose()
  }
}
