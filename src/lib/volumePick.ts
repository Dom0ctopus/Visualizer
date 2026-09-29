/**
 * Which label the voxel render shows under a screen point. itk-vtk-viewer
 * has no picking for volume renderings, so this casts the ray itself
 * through the image the viewer has loaded (its fused CT + label image, at
 * whatever resolution is currently displayed) and composites opacity the
 * way the renderer does, returning the label where the ray becomes mostly
 * opaque.
 *
 * The opacity model follows the render's settings: the CT's opacity
 * function, and the label component in itk-vtk-viewer's "proportional"
 * opacity mode, which scales the CT's opacity by the label's own opacity
 * (per-segment visibility/opacity from the segment tree) weighted by the
 * label blend: alpha = ctAlpha * (1 - blend + blend * labelAlpha). So at
 * full blend unlabeled tissue is transparent and the first visible segment
 * is reported; at lower blend CT in front of a segment hides it. Crop
 * planes are respected, and so are null voxels (the volume's minimum
 * value, empty space in a masked scan), which the render draws as
 * transparent whatever the opacity curve says. Soft, semi-transparent edges can differ from the
 * render by a voxel or so; clearly visible segments match.
 */

interface VtkPiecewiseFunction {
  getValue: (x: number) => number
}
interface VtkPlane {
  getNormal: () => number[]
  getOrigin: () => number[]
}
interface VtkImageData {
  getDimensions: () => number[]
  getSpacing: () => number[]
  worldToIndex: (world: number[], out: number[]) => number[]
  indexToWorld: (index: number[], out: number[]) => number[]
  getPointData: () => {
    getScalars: () => { getNumberOfComponents: () => number; getData: () => ArrayLike<number>; getRange: (component: number) => number[] } | null
  }
}
export interface PickableVolume {
  getProperty: () => {
    getScalarOpacity: (component: number) => VtkPiecewiseFunction | null
    getScalarOpacityUnitDistance: (component: number) => number
    getComponentWeight: (component: number) => number
  }
  getMapper: () => { getInputData: () => VtkImageData | null; getClippingPlanes?: () => VtkPlane[] } | null
}
export interface PickableViewProxy {
  getRenderer: () => unknown
  getOpenGLRenderWindow: () => {
    getSize: () => number[]
    getCanvas: () => HTMLCanvasElement | null
    displayToWorld: (x: number, y: number, z: number, renderer: unknown) => number[]
  }
  getRepresentations: () => Array<{ getVolumes?: () => PickableVolume[] }>
}

/** Accumulated opacity at which the ray counts as having hit something. */
const HIT_OPACITY = 0.5
/** Samples per voxel along the ray. */
const SAMPLES_PER_VOXEL = 2

/** The label value shown at (clientX, clientY), or null for none. */
export function pickVolumeLabel(viewProxy: PickableViewProxy, clientX: number, clientY: number): number | null {
  const volume = viewProxy.getRepresentations().flatMap((r) => r.getVolumes?.() ?? [])[0]
  const mapper = volume?.getMapper()
  const image = mapper?.getInputData()
  const scalars = image?.getPointData().getScalars()
  if (!volume || !mapper || !image || !scalars) return null
  const components = scalars.getNumberOfComponents()
  if (components < 2) return null // no label image fused in
  const property = volume.getProperty()
  const ctOpacity = property.getScalarOpacity(0)
  const labelOpacity = property.getScalarOpacity(components - 1)
  if (!ctOpacity || !labelOpacity) return null
  const blend = property.getComponentWeight(components - 1)
  if (blend <= 0) return null // labels aren't drawn at all
  const unitDistance = property.getScalarOpacityUnitDistance(0) || 1

  // Screen point -> world-space ray (vtk display coordinates are device
  // pixels from the bottom-left).
  const renderWindow = viewProxy.getOpenGLRenderWindow()
  const canvas = renderWindow.getCanvas()
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  const [width, height] = renderWindow.getSize()
  if (!rect.width || !rect.height) return null
  const dx = ((clientX - rect.left) * width) / rect.width
  const dy = height - ((clientY - rect.top) * height) / rect.height
  const renderer = viewProxy.getRenderer()
  const near = renderWindow.displayToWorld(dx, dy, 0, renderer)
  const far = renderWindow.displayToWorld(dx, dy, 1, renderer)

  // March in index space, clipped to the image's extent.
  const dims = image.getDimensions()
  const a = image.worldToIndex(near, [0, 0, 0])
  const b = image.worldToIndex(far, [0, 0, 0])
  const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  let t0 = 0
  let t1 = 1
  for (let axis = 0; axis < 3; axis++) {
    const lo = -0.5
    const hi = dims[axis] - 0.5
    if (Math.abs(dir[axis]) < 1e-12) {
      if (a[axis] < lo || a[axis] > hi) return null
      continue
    }
    let ta = (lo - a[axis]) / dir[axis]
    let tb = (hi - a[axis]) / dir[axis]
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
    if (t0 >= t1) return null
  }
  const indexLength = Math.hypot(dir[0], dir[1], dir[2])
  const steps = Math.ceil((t1 - t0) * indexLength * SAMPLES_PER_VOXEL)
  if (steps <= 0) return null
  const dt = (t1 - t0) / steps

  // One step's physical length, for opacity correction (vtk's opacity
  // functions are per unit distance).
  const spacing = image.getSpacing()
  const stepWorld = Math.hypot(dir[0] * dt * spacing[0], dir[1] * dt * spacing[1], dir[2] * dt * spacing[2])
  const exponent = stepWorld / unitDistance

  const planes = (mapper.getClippingPlanes?.() ?? []).map((p) => ({ n: p.getNormal(), o: p.getOrigin() }))
  const data = scalars.getData()
  const nullValue = scalars.getRange(0)[0]
  const [nx, ny] = dims
  const world = [0, 0, 0]
  let transparency = 1
  for (let s = 0; s <= steps; s++) {
    const t = t0 + s * dt
    const x = Math.round(a[0] + dir[0] * t)
    const y = Math.round(a[1] + dir[1] * t)
    const z = Math.round(a[2] + dir[2] * t)
    if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) continue
    if (planes.length) {
      image.indexToWorld([x, y, z], world)
      if (planes.some(({ n, o }) => (world[0] - o[0]) * n[0] + (world[1] - o[1]) * n[1] + (world[2] - o[2]) * n[2] < 0)) continue
    }
    const offset = ((z * ny + y) * nx + x) * components
    if (data[offset] === nullValue) continue
    const label = data[offset + components - 1]
    const alpha = ctOpacity.getValue(data[offset]) * (1 - blend + blend * labelOpacity.getValue(label))
    if (alpha <= 0) continue
    transparency *= Math.pow(1 - Math.min(alpha, 0.999), exponent)
    if (1 - transparency >= HIT_OPACITY) return label > 0 && labelOpacity.getValue(label) > 0 ? label : null
  }
  return null
}
