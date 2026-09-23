import type { SliceOverlay } from '../hooks/useSegmentationOverlays'
import type { Rect } from './sliceGeometry'
import type { SliceResult } from './zarrClient'

/**
 * GPU compositing for one 2D pane. The base slice and each overlay's label
 * slice are single-channel float textures; each overlay's color/opacity
 * table is a small RGBA texture. The fragment shaders do window/level and
 * the label -> color lookup per screen pixel, so:
 *
 *  - window/level, zoom and pan are uniform changes -- no CPU work at all;
 *  - a new slice or overlay set costs one texture upload, not a per-pixel
 *    JS loop over every overlay;
 *  - voxels are sampled with texelFetch (nearest neighbor) at screen
 *    resolution, so they stay crisp at any zoom.
 *
 * Overlays are composited one draw per overlay with standard alpha blending
 * (dst = src * a + dst * (1 - a)), the same math the old CPU loop used.
 */

const VERT = `#version 300 es
in vec2 a_unit;
// Clip-space image rect: x0, y0 (top-left), x1, y1 (bottom-right).
uniform vec4 u_rect;
out vec2 v_uv;
void main() {
  v_uv = a_unit;
  gl_Position = vec4(mix(u_rect.x, u_rect.z, a_unit.x), mix(u_rect.y, u_rect.w, a_unit.y), 0.0, 1.0);
}`

// v_uv.y = 0 is the top of the displayed image; storage row 0 is drawn at
// the top unless u_flip (coronal/sagittal: superior up).
const STORAGE_PIXEL = `
uniform ivec2 u_size;
uniform bool u_flip;
ivec2 storagePixel() {
  int x = min(int(floor(v_uv.x * float(u_size.x))), u_size.x - 1);
  int row = min(int(floor(v_uv.y * float(u_size.y))), u_size.y - 1);
  return ivec2(x, u_flip ? u_size.y - 1 - row : row);
}`

const BASE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_slice;
uniform float u_windowMin;
uniform float u_windowMax;
${STORAGE_PIXEL}
void main() {
  float v = texelFetch(u_slice, storagePixel(), 0).r;
  float t = clamp((v - u_windowMin) / max(u_windowMax - u_windowMin, 1e-6), 0.0, 1.0);
  outColor = vec4(t, t, t, 1.0);
}`

const OVERLAY_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_labels;
uniform sampler2D u_lut;
// scaleX, scaleY, offsetX, offsetY: base pixel -> this overlay's own pixel.
uniform vec4 u_map;
uniform ivec2 u_labelSize;
uniform int u_lutWidth;
uniform int u_lutCount;
${STORAGE_PIXEL}
void main() {
  ivec2 p = storagePixel();
  // floor(v + 0.5) matches JS Math.round, which hover lookups use.
  int ox = int(floor(float(p.x) * u_map.x + u_map.z + 0.5));
  int oy = int(floor(float(p.y) * u_map.y + u_map.w + 0.5));
  if (ox < 0 || oy < 0 || ox >= u_labelSize.x || oy >= u_labelSize.y) discard;
  int label = int(texelFetch(u_labels, ivec2(ox, oy), 0).r + 0.5);
  if (label <= 0 || label >= u_lutCount) discard;
  vec4 c = texelFetch(u_lut, ivec2(label % u_lutWidth, label / u_lutWidth), 0);
  if (c.a == 0.0) discard;
  outColor = c;
}`

const LUT_MAX_WIDTH = 4096

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return shader
}

function link(gl: WebGL2RenderingContext, frag: string): WebGLProgram {
  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag))
  gl.bindAttribLocation(program, 0, 'a_unit')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`)
  }
  return program
}

function toFloat32(data: SliceResult['data']): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data)
}

interface LutTexture {
  texture: WebGLTexture
  width: number
  count: number
}

export interface DrawParams {
  /** Image rect in CSS pixels, relative to the canvas (see sliceGeometry.ts). */
  rect: Rect
  cssWidth: number
  cssHeight: number
  windowMin: number
  windowMax: number
  flipY: boolean
}

export class SliceRenderer {
  private gl: WebGL2RenderingContext
  private baseProgram: WebGLProgram
  private overlayProgram: WebGLProgram
  private vao: WebGLVertexArrayObject
  private maxTextureSize: number
  private baseTexture: WebGLTexture | null = null
  private baseSource: SliceResult | null = null
  private labelTextures = new Map<SliceOverlay['data'], WebGLTexture>()
  private lutTextures = new Map<Uint8ClampedArray, LutTexture>()
  private overlays: SliceOverlay[] = []

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false })
    if (!gl) throw new Error('WebGL2 is not available in this browser.')
    this.gl = gl
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    this.baseProgram = link(gl, BASE_FRAG)
    this.overlayProgram = link(gl, OVERLAY_FRAG)
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  }

  private createTexture(width: number, height: number, internalFormat: number, format: number, type: number, data: ArrayBufferView): WebGLTexture {
    if (width > this.maxTextureSize || height > this.maxTextureSize) {
      throw new Error(`Slice ${width}x${height} exceeds this GPU's max texture size (${this.maxTextureSize}); pick a coarser resolution level.`)
    }
    const gl = this.gl
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data)
    return texture
  }

  setSlice(slice: SliceResult | null): void {
    if (slice === this.baseSource) return
    const gl = this.gl
    if (this.baseTexture) gl.deleteTexture(this.baseTexture)
    this.baseTexture = null
    this.baseSource = slice
    if (slice) this.baseTexture = this.createTexture(slice.width, slice.height, gl.R32F, gl.RED, gl.FLOAT, toFloat32(slice.data))
  }

  setOverlays(overlays: SliceOverlay[]): void {
    const gl = this.gl
    this.overlays = overlays
    const liveData = new Set(overlays.map((o) => o.data))
    const liveLuts = new Set(overlays.map((o) => o.lut))
    for (const [data, texture] of this.labelTextures) {
      if (!liveData.has(data)) {
        gl.deleteTexture(texture)
        this.labelTextures.delete(data)
      }
    }
    for (const [lut, entry] of this.lutTextures) {
      if (!liveLuts.has(lut)) {
        gl.deleteTexture(entry.texture)
        this.lutTextures.delete(lut)
      }
    }
    for (const overlay of overlays) {
      if (!this.labelTextures.has(overlay.data)) {
        this.labelTextures.set(overlay.data, this.createTexture(overlay.width, overlay.height, gl.R32F, gl.RED, gl.FLOAT, toFloat32(overlay.data)))
      }
      if (!this.lutTextures.has(overlay.lut)) {
        const count = overlay.lut.length / 4
        const width = Math.min(count, LUT_MAX_WIDTH)
        const height = Math.ceil(count / width)
        const padded = new Uint8Array(width * height * 4)
        padded.set(overlay.lut)
        this.lutTextures.set(overlay.lut, { texture: this.createTexture(width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, padded), width, count })
      }
    }
  }

  draw(p: DrawParams): void {
    const gl = this.gl
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const slice = this.baseSource
    if (!slice || !this.baseTexture || p.rect.width <= 0 || p.rect.height <= 0 || p.cssWidth <= 0 || p.cssHeight <= 0) return

    const x0 = (p.rect.left / p.cssWidth) * 2 - 1
    const x1 = ((p.rect.left + p.rect.width) / p.cssWidth) * 2 - 1
    const y0 = 1 - (p.rect.top / p.cssHeight) * 2
    const y1 = 1 - ((p.rect.top + p.rect.height) / p.cssHeight) * 2
    gl.bindVertexArray(this.vao)

    gl.useProgram(this.baseProgram)
    const bp = this.baseProgram
    gl.uniform4f(gl.getUniformLocation(bp, 'u_rect'), x0, y0, x1, y1)
    gl.uniform2i(gl.getUniformLocation(bp, 'u_size'), slice.width, slice.height)
    gl.uniform1i(gl.getUniformLocation(bp, 'u_flip'), p.flipY ? 1 : 0)
    gl.uniform1f(gl.getUniformLocation(bp, 'u_windowMin'), p.windowMin)
    gl.uniform1f(gl.getUniformLocation(bp, 'u_windowMax'), p.windowMax)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.baseTexture)
    gl.uniform1i(gl.getUniformLocation(bp, 'u_slice'), 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    if (this.overlays.length === 0) return
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    const op = this.overlayProgram
    gl.useProgram(op)
    gl.uniform4f(gl.getUniformLocation(op, 'u_rect'), x0, y0, x1, y1)
    gl.uniform2i(gl.getUniformLocation(op, 'u_size'), slice.width, slice.height)
    gl.uniform1i(gl.getUniformLocation(op, 'u_flip'), p.flipY ? 1 : 0)
    gl.uniform1i(gl.getUniformLocation(op, 'u_labels'), 0)
    gl.uniform1i(gl.getUniformLocation(op, 'u_lut'), 1)
    for (const overlay of this.overlays) {
      const labels = this.labelTextures.get(overlay.data)
      const lut = this.lutTextures.get(overlay.lut)
      if (!labels || !lut) continue
      gl.uniform4f(gl.getUniformLocation(op, 'u_map'), overlay.scaleX, overlay.scaleY, overlay.offsetX, overlay.offsetY)
      gl.uniform2i(gl.getUniformLocation(op, 'u_labelSize'), overlay.width, overlay.height)
      gl.uniform1i(gl.getUniformLocation(op, 'u_lutWidth'), lut.width)
      gl.uniform1i(gl.getUniformLocation(op, 'u_lutCount'), lut.count)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, labels)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, lut.texture)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
  }

  dispose(): void {
    const gl = this.gl
    if (this.baseTexture) gl.deleteTexture(this.baseTexture)
    for (const t of this.labelTextures.values()) gl.deleteTexture(t)
    for (const t of this.lutTextures.values()) gl.deleteTexture(t.texture)
    this.labelTextures.clear()
    this.lutTextures.clear()
    gl.deleteProgram(this.baseProgram)
    gl.deleteProgram(this.overlayProgram)
    gl.deleteVertexArray(this.vao)
    // No forced loseContext(): the context belongs to the canvas, and a
    // remount on the same canvas (React StrictMode does this in dev) gets the
    // same context back from getContext -- permanently lost, if we'd lost it.
  }
}
