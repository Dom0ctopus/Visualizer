/**
 * The voxel render's crop box: an oriented box in world space (mm, x/y/z),
 * cut by six clipping planes, which can be turned to any angle (see
 * CropBoxOverlay.tsx). Unlike itk-vtk-viewer's own cropping tool, whose box
 * always follows the volume's axes.
 */

export type Vec3 = [number, number, number]

export interface CropBox {
  center: Vec3
  /** Half the box's size along each of its own axes. */
  half: Vec3
  /** The box's own axes, unit vectors in world space. */
  axes: [Vec3, Vec3, Vec3]
}

/** A clipping plane: the kept side is where dot(p - origin, normal) >= 0. */
export interface CropPlane {
  origin: Vec3
  normal: Vec3
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1))

/** An axis-aligned box filling `bounds` ([xmin, xmax, ymin, ymax, zmin, zmax]). */
export function boxFromBounds(bounds: number[]): CropBox {
  return {
    center: [(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2, (bounds[4] + bounds[5]) / 2],
    half: [(bounds[1] - bounds[0]) / 2, (bounds[3] - bounds[2]) / 2, (bounds[5] - bounds[4]) / 2],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ]
  }
}

/** Faces are numbered -x, +x, -y, +y, -z, +z of the box's own axes. */
export function faceOutwardNormal(box: CropBox, face: number): Vec3 {
  return scale(box.axes[face >> 1], face % 2 ? 1 : -1)
}

export function faceCenter(box: CropBox, face: number): Vec3 {
  return add(box.center, scale(faceOutwardNormal(box, face), box.half[face >> 1]))
}

/** The six clipping planes, one per face, normals pointing into the box. */
export function boxPlanes(box: CropBox): CropPlane[] {
  return [0, 1, 2, 3, 4, 5].map((face) => ({ origin: faceCenter(box, face), normal: scale(faceOutwardNormal(box, face), -1) }))
}

/** Corner i has bit 0, 1, 2 set for the +x, +y, +z side of the box's axes. */
export function boxCorners(box: CropBox): Vec3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
    [0, 1, 2].reduce<Vec3>((p, axis) => add(p, scale(box.axes[axis], (i >> axis) & 1 ? box.half[axis] : -box.half[axis])), box.center)
  )
}

/** Corner index pairs of the box's twelve edges. */
export const BOX_EDGES: Array<[number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7]
]

/** `v` turned by `angle` (radians) about the unit vector `axis`. */
function rotateVector(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return add(add(scale(v, cos), scale(cross(axis, v), sin)), scale(axis, dot(axis, v) * (1 - cos)))
}

/** The box turned about its own center by `angle` about world `axis`. */
export function rotateBox(box: CropBox, axis: Vec3, angle: number): CropBox {
  const unit = normalize(axis)
  const axes = box.axes.map((a) => normalize(rotateVector(a, unit, angle))) as [Vec3, Vec3, Vec3]
  return { ...box, axes }
}

/** The box with one face moved `distance` (mm) outward (negative: inward),
 *  the opposite face staying put; never thinner than `minHalf` * 2. */
export function moveFace(box: CropBox, face: number, distance: number, minHalf: number): CropBox {
  const axis = face >> 1
  const half = Math.max(minHalf, box.half[axis] + distance / 2)
  const moved = (half - box.half[axis]) * 2
  const newHalf = [...box.half] as Vec3
  newHalf[axis] = half
  return { ...box, half: newHalf, center: add(box.center, scale(faceOutwardNormal(box, face), moved / 2)) }
}
