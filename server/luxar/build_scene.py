#!/usr/bin/env python3
"""Compiles Luxar (https://github.com/royerlab/luxar) scenes for the visualizer.

Run by the Node server (server/src/luxarScenes.ts) inside the Luxar Python
environment that `npm run setup:luxar` creates. Two modes, each driven by a
JSON spec the server writes:

  meshes  One Luxar mesh node per segment, built from the surface meshes
          server/src/surfaceMesh.ts already generated (exact geometry at the
          finest level; big meshes also get decimated coarser levels so the
          viewer streams only what the view needs). Each segment is its own
          toggleable layer with its name as the hover label.

  atlas   A "splat atlas" in the style of Luxar's TotalSegmentator demo: the
          CT volume is fitted with Gaussian splats and each splat is colored by
          the segment under its center (sampled at the segmentation's native
          resolution), one toggleable layer per segment system plus a dim
          "unlabeled tissue" context layer. This is an artistic, lossy
          representation (a fit, not the voxels).

Progress goes to stdout as lines of the form `PROGRESS <text>`; anything else
on stdout/stderr is log output. Exit status is nonzero on failure.

Usage: build_scene.py meshes|atlas <spec.json>
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np
from arbol import Arbol

# Plain log lines: the server captures them, no terminal colors.
Arbol.colorful = False


def progress(text: str) -> None:
    print(f"PROGRESS {text}", flush=True)


def log(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


def xyz_dimensions():
    from luxar import Dimension, Dimensions

    return Dimensions(
        [
            Dimension("x", unit="mm", display=True),
            Dimension("y", unit="mm", display=True),
            Dimension("z", unit="mm", display=True),
        ]
    )


def front_camera(lo: np.ndarray, hi: np.ndarray):
    """Anterior view with superior up. Coordinates are LPS (+y posterior,
    +z superior), matching the app's other 3D views."""
    from luxar import CameraConfig

    center = (lo + hi) / 2.0
    size = float(np.max(hi - lo)) or 1.0
    distance = (size * 0.5) / np.tan(np.radians(35.0) / 2.0) * 1.3
    return CameraConfig(
        position=(float(center[0]), float(center[1] - distance), float(center[2])),
        target=(float(center[0]), float(center[1]), float(center[2])),
        up=(0.0, 0.0, 1.0),
        near=float(max(0.01, distance * 0.01)),
        far=float(distance * 10.0 + size * 5.0),
    )


def compile_to(output: Path, build) -> None:
    """Writes the scene to a sibling temp dir, then swaps it into place, so
    the server never serves a half-written archive."""
    from luxar import LuxarZarrCompiler

    # The compiler names its output `<path>.luxar.zarr` unless the path
    # already ends that way, so the temp dir keeps that suffix too.
    tmp = output.with_name(output.name.removesuffix(".luxar.zarr") + ".building.luxar.zarr")
    shutil.rmtree(tmp, ignore_errors=True)
    with LuxarZarrCompiler(tmp) as compiler:
        build(compiler)
    shutil.rmtree(output, ignore_errors=True)
    tmp.rename(output)


# =============================================================================
# Meshes
# =============================================================================

# Surfaces above this many triangles get a decimated LOD ladder; smaller ones
# are cheap enough to draw whole.
MESH_LOD_MIN_TRIANGLES = 200_000
# The viewer loads each mesh node whole and refuses one over 512 MiB decoded
# (~18M triangles with normals and colors). Larger surfaces are split
# spatially into parts of at most this many triangles, each its own node
# (with its own LOD ladder) under one layer group; smaller parts also let the
# viewer skip the ones out of view.
MESH_PART_MAX_TRIANGLES = 2_000_000


def read_mesh_bin(path: str) -> tuple[np.ndarray, np.ndarray]:
    """server/src/surfaceMesh.ts's format:
    [u32 vertexCount][u32 triangleCount][f32 xyz * V][u32 abc * T]."""
    raw = np.fromfile(path, dtype=np.uint8)
    vertex_count, triangle_count = raw[:8].view(np.uint32)
    v_end = 8 + int(vertex_count) * 12
    vertices = raw[8:v_end].view(np.float32).reshape(-1, 3)
    faces = raw[v_end : v_end + int(triangle_count) * 12].view(np.uint32).reshape(-1, 3)
    return vertices, faces


def vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals over the whole surface (so a split
    surface shades seamlessly across part boundaries)."""
    v0 = vertices[faces[:, 0]].astype(np.float64)
    face_normals = np.cross(vertices[faces[:, 1]] - v0, vertices[faces[:, 2]] - v0)
    normals = np.zeros((len(vertices), 3), dtype=np.float64)
    for corner in range(3):
        np.add.at(normals, faces[:, corner], face_normals)
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    return (normals / np.where(lengths > 0, lengths, 1.0)).astype(np.float32)


def spatial_face_parts(vertices: np.ndarray, faces: np.ndarray, max_faces: int) -> list[np.ndarray]:
    """Splits the faces into spatially compact groups of at most `max_faces`
    each: recursive median cuts of the face centroids along each group's
    longest axis."""
    from luxar.mesh.split import face_centroids

    centroids = face_centroids(vertices, faces)
    pending = [np.arange(len(faces))]
    parts = []
    while pending:
        idx = pending.pop()
        if len(idx) <= max_faces:
            parts.append(idx)
            continue
        c = centroids[idx]
        axis = int(np.argmax(c.max(axis=0) - c.min(axis=0)))
        order = np.argsort(c[:, axis], kind="stable")
        half = len(idx) // 2
        pending += [idx[order[:half]], idx[order[half:]]]
    return parts


# The LOD ladder (see add() in build_meshes): two levels at 8x.
MESH_LOD_SPEC = {"method": "cluster", "levels": 2, "K": 8}
# Segments are processed in batches of about this many triangles, so memory
# stays bounded; within a batch, every part's decimation runs in parallel.
MESH_BATCH_TRIANGLES = 24_000_000


def ladder_targets(n_vertices: int) -> list[int]:
    """The vertex targets Luxar's substitutive-LOD writer asks decimation for,
    for MESH_LOD_SPEC (coarsest first)."""
    k, levels = MESH_LOD_SPEC["K"], MESH_LOD_SPEC["levels"]
    return [n_vertices // k**p for p in range(levels, 0, -1) if n_vertices // k**p >= 4]


def ladder_key(vertices: np.ndarray, faces: np.ndarray) -> tuple:
    v = np.ascontiguousarray(vertices, dtype=np.float32)
    f = np.ascontiguousarray(faces, dtype=np.uint32).reshape(-1, 3)
    return (len(v), len(f), v[0].tobytes(), v[-1].tobytes(), f[:4].tobytes(), f[-4:].tobytes())


def decimate_part(args: tuple) -> tuple:
    """Worker: one part's LOD ladder, exactly as Luxar's writer would compute
    it (same targets, method and attributes)."""
    from arbol import Arbol
    from luxar.mesh.decimate import decimate_ladder

    Arbol.enable_output = False
    vertices, faces, normals = args
    ladder = decimate_ladder(
        vertices,
        faces,
        target_vertices=ladder_targets(len(vertices)),
        method="cluster",
        normals=normals,
        normal_dims=(0, 1, 2),
        colors=None,
        scalars=None,
        spatial_dims=None,
        attribute_weight=0.0,
    )
    return ladder_key(vertices, faces), ladder


# Ladders computed ahead of time by the worker pool, consumed by the patched
# decimate_ladder below when Luxar's writer asks for them.
PRECOMPUTED_LADDERS: dict = {}


def install_ladder_cache() -> None:
    """Luxar decimates inside add_mesh, one surface at a time on one core --
    most of a big mesh scene's build time. build_meshes computes the ladders
    in parallel first; this makes Luxar's writer take a precomputed ladder
    when it asks for one with the same arguments, and compute it itself
    otherwise."""
    import importlib

    # By module path: `luxar.mesh.decimate` as an attribute is a function
    # (the package re-exports `decimate`), not this module.
    decimate_module = importlib.import_module("luxar.mesh.decimate")

    original = decimate_module.decimate_ladder

    def cached(vertices, faces, *, target_vertices, method="auto", **kwargs):
        hit = PRECOMPUTED_LADDERS.pop(ladder_key(vertices, faces), None)
        same_request = (
            hit is not None
            and method == "cluster"
            and list(target_vertices) == ladder_targets(len(vertices))
            and kwargs.get("colors") is None
            and kwargs.get("scalars") is None
            and float(kwargs.get("attribute_weight", 0.0)) == 0.0
            and kwargs.get("spatial_dims") in (None, (0, 1, 2), [0, 1, 2])
        )
        if same_request:
            return hit
        return original(vertices, faces, target_vertices=target_vertices, method=method, **kwargs)

    decimate_module.decimate_ladder = cached


def mesh_worker_count() -> int:
    """Worker processes for decimation: the cores (less one), capped so each
    has ~1.5 GB of memory for a 2M-triangle part. LUXAR_MESH_WORKERS
    overrides; 0 leaves decimation to Luxar (serial, in this process)."""
    import os

    if os.environ.get("LUXAR_MESH_WORKERS"):
        return max(0, int(os.environ["LUXAR_MESH_WORKERS"]))
    cores = max(1, (os.cpu_count() or 2) - 1)
    try:
        memory = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        cores = min(cores, max(1, int(memory / (1.5 * 1024**3))))
    except (ValueError, OSError, AttributeError):
        pass
    return cores


def build_meshes(spec: dict) -> None:
    import multiprocessing
    from concurrent.futures import ProcessPoolExecutor

    segments = spec["segments"]
    max_part = int(spec.get("maxPartTriangles", MESH_PART_MAX_TRIANGLES))

    # Bounds (for the camera) from a first pass, so only one batch of
    # surfaces is ever in memory: micro-CT segmentations can total hundreds
    # of millions of triangles.
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    total = 0
    for i, seg in enumerate(segments):
        progress(f"reading mesh {i + 1}/{len(segments)}")
        vertices, faces = read_mesh_bin(seg["file"])
        if len(faces) == 0:
            continue
        lo = np.minimum(lo, vertices.min(axis=0))
        hi = np.maximum(hi, vertices.max(axis=0))
        total += len(faces)
    if total == 0:
        raise SystemExit("No non-empty segment meshes to compile")

    workers = mesh_worker_count()
    log(f"{total:,} triangles; decimating on {workers or 'no'} worker process(es)")
    if workers:
        install_ladder_cache()

    def build(compiler) -> None:
        from luxar.core.viewer_config import ViewerConfig
        from luxar.mesh.split import split_mesh_by_faces

        scene = compiler.create_scene(
            dimensions=xyz_dimensions(),
            viewer_config=ViewerConfig(camera=front_camera(lo, hi)),
        )
        scene.attrs["title"] = spec.get("title", "Surface meshes")
        done = 0

        def add(parent, seg, name: str, v: np.ndarray, f: np.ndarray, n: np.ndarray, **attrs) -> None:
            if len(f) > MESH_LOD_MIN_TRIANGLES:
                # 'cluster' (vertex clustering) rather than QEM: it stays fast
                # on the huge surfaces micro-CT segmentations produce. Two
                # levels at 8x rather than Luxar's default three at 4x: ~25%
                # less work, and the coarse end is what matters for a
                # whole-specimen view.
                attrs["substitutive_lod"] = dict(MESH_LOD_SPEC)
            parent.add_mesh(
                name=name,
                vertices=v,
                faces=f,
                normals=n,
                normal_dims=[0, 1, 2],
                colors=tuple(float(c) for c in seg["color"]),
                labels=[seg["name"]] * len(v),
                shading="smooth",
                **attrs,
            )

        def flush(batch: list, pool) -> None:
            nonlocal done
            # Every part (a whole segment counts as one) of the batch.
            items = []
            for seg, vertices, faces, normals in batch:
                if len(faces) <= max_part:
                    items.append((seg, None, vertices, faces, normals))
                else:
                    parts = split_mesh_by_faces(faces, spatial_face_parts(vertices, faces, max_part))
                    for j, part in enumerate(parts):
                        vi = part.vertex_index
                        items.append((seg, (j, len(parts)), vertices[vi], part.faces, normals[vi]))
            jobs = [(v, f, n) for _, _, v, f, n in items if len(f) > MESH_LOD_MIN_TRIANGLES] if pool else []
            if jobs:
                finished = 0
                for key, ladder in pool.map(decimate_part, jobs):
                    PRECOMPUTED_LADDERS[key] = ladder
                    finished += 1
                    progress(f"simplifying surfaces: {finished}/{len(jobs)} ({done:,}/{total:,} triangles written)")
            groups = {}
            for seg, part, v, f, n in items:
                if part is None:
                    progress(f"writing {seg['name']} ({done:,}/{total:,} triangles)")
                    add(scene, seg, seg["layerName"], v, f, n, layer=True)
                else:
                    j, count = part
                    progress(f"writing {seg['name']} part {j + 1}/{count} ({done:,}/{total:,} triangles)")
                    if seg["layerName"] not in groups:
                        groups[seg["layerName"]] = scene.add_group(seg["layerName"], layer=True)
                    add(groups[seg["layerName"]], seg, f"part_{j}", v, f, n)
                done += len(f)
            PRECOMPUTED_LADDERS.clear()

        pool = ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn")) if workers else None
        try:
            batch, batch_triangles = [], 0
            for seg in segments:
                vertices, faces = read_mesh_bin(seg["file"])
                if len(faces) == 0:
                    continue
                batch.append((seg, vertices, faces, vertex_normals(vertices, faces)))
                batch_triangles += len(faces)
                if batch_triangles >= MESH_BATCH_TRIANGLES:
                    flush(batch, pool)
                    batch, batch_triangles = [], 0
            if batch:
                flush(batch, pool)
        finally:
            if pool:
                pool.shutdown()

    compile_to(Path(spec["output"]), build)


# =============================================================================
# Splat atlas
# =============================================================================


def otsu_threshold(values: np.ndarray, bins: int = 256) -> float:
    hist, edges = np.histogram(values, bins=bins)
    hist = hist.astype(np.float64)
    centers = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * centers)
    mean0 = np.divide(m0, w0, out=np.zeros_like(m0), where=w0 > 0)
    mean1 = np.divide(m0[-1] - m0, w1, out=np.zeros_like(m0), where=w1 > 0)
    between = w0 * w1 * (mean0 - mean1) ** 2
    return float(centers[int(np.argmax(between))])


class Multiscale:
    """One OME-Zarr (NGFF 0.4, Zarr v2) multiscale group as the server writes
    them: axes [z, y, x], per-level scale + translation in mm (the physical
    position of voxel [0, 0, 0]'s center)."""

    def __init__(self, group_path: str) -> None:
        import zarr

        attrs = json.loads((Path(group_path) / ".zattrs").read_text())
        self.levels = []
        for ds in attrs["multiscales"][0]["datasets"]:
            transforms = {t["type"]: t for t in ds["coordinateTransformations"]}
            array = zarr.open_array(str(Path(group_path) / ds["path"]), mode="r")
            self.levels.append(
                {
                    "array": array,
                    "shape": tuple(array.shape),
                    "scale": np.asarray(transforms["scale"]["scale"], dtype=np.float64),
                    "translation": np.asarray(transforms.get("translation", {"translation": [0, 0, 0]})["translation"], dtype=np.float64),
                }
            )
        self.levels.sort(key=lambda lv: float(np.prod(lv["scale"])))


def axis_index_map(n_in: int, in_origin: float, in_spacing: float, out_origin: float, out_spacing: float, n_out: int) -> np.ndarray:
    """For each input voxel along one axis, the output (grid) voxel whose
    cell contains its center, or -1 outside the grid."""
    idx = np.floor((in_origin + np.arange(n_in) * in_spacing - out_origin) / out_spacing + 0.5).astype(np.int64)
    idx[(idx < 0) | (idx >= n_out)] = -1
    return idx


# Label voxels processed at a time (the per-voxel index arrays are 8 bytes
# each, so this bounds working memory to a few hundred MB).
SLAB_VOXELS = 16 * 1024 * 1024


def segment_coverage(level, grid_shape, grid_origin, grid_spacing, lut: np.ndarray, into: dict) -> None:
    """Accumulates, for each atlas id in `lut`, how many of this label
    level's voxels fall in each atlas-grid voxel -- a sparse (flat grid
    index -> count) per id in `into`. Counting at a finer level than the
    grid keeps structures thinner than a grid voxel (vessels, nerves) as
    partial coverage instead of losing them to nearest-neighbor sampling.
    Reads the level in z slabs."""
    shape = level["shape"]
    maps = [axis_index_map(shape[a], level["translation"][a], level["scale"][a], grid_origin[a], grid_spacing[a], grid_shape[a]) for a in range(3)]
    ny, nx = grid_shape[1], grid_shape[2]
    yx = np.where((maps[1][:, None] >= 0) & (maps[2][None, :] >= 0), maps[1][:, None] * nx + maps[2][None, :], -1)
    slab = max(1, SLAB_VOXELS // max(1, shape[1] * shape[2]))
    for z0 in range(0, shape[0], slab):
        block = np.asarray(level["array"][z0 : min(z0 + slab, shape[0])])
        ids = lut[np.clip(block, 0, len(lut) - 1)]
        gz = maps[0][z0 : z0 + block.shape[0]]
        flat = np.where((gz[:, None, None] >= 0) & (yx[None] >= 0), gz[:, None, None] * (ny * nx) + yx[None], -1)
        hit = (ids > 0) & (flat >= 0)
        if not hit.any():
            continue
        ids_hit = ids[hit]
        flat_hit = flat[hit]
        for atlas_id in np.unique(ids_hit):
            cells, counts = np.unique(flat_hit[ids_hit == atlas_id], return_counts=True)
            into.setdefault(int(atlas_id), []).append((cells, counts))


def coverage_grid(parts: list, grid_size: int, voxels_per_cell: float) -> np.ndarray:
    """Dense per-grid-voxel coverage fraction (0-1) from segment_coverage's
    sparse counts."""
    out = np.zeros(grid_size, dtype=np.float32)
    for cells, counts in parts:
        np.add.at(out, cells, counts.astype(np.float32))
    return np.minimum(out / voxels_per_cell, 1.0)


# Fitted intensity of segment tissue: coverage x (LABELED_FLOOR + (1 - floor)
# x windowed CT). Artistic license, as in Luxar's own CT atlas: left as-is,
# dense bone takes nearly all the brightness and soft tissue barely shows, so
# segment tissue is lifted onto a floor, keeping its CT texture on top.
LABELED_FLOOR = 0.4
# Fitted intensity of unlabeled context tissue: CONTEXT_SCALE x windowed CT.
CONTEXT_SCALE = 0.6
# Share of the splat budget for the unlabeled-tissue context layer, and its
# brightness gain: a faint glow that shows the body without veiling the
# segments inside it.
CONTEXT_BUDGET_SHARE = 0.1
CONTEXT_GAIN = 0.1
# Each segment is fitted on its own, with a budget proportional to the square
# root of its size (so a large organ can't take the whole budget and starve
# small structures), but at least this many splats.
MIN_SEGMENT_SPLATS = 40
# Per-segment brightness equalization. The viewer draws each splat as a flat
# blob summed additively, so on-screen brightness grows with how many splats
# stack along a ray and with the color's luminance -- left alone, dense or
# white structures blow out and thin or dark ones vanish. Each segment's gain
# brings its estimated brightness (luminance x summed splat footprint per
# projected area, seen from the front) to the median segment's, times
# ATLAS_EXPOSURE, within LAYER_GAIN_RANGE. The viewer's Layers panel can
# still adjust each layer.
ATLAS_EXPOSURE = 0.9
LAYER_GAIN_RANGE = (0.2, 2.5)


def layer_brightness(centers: np.ndarray, amplitudes: np.ndarray, cholesky: np.ndarray, colors: np.ndarray, pixel: float) -> float:
    """Estimated front-view (x-z plane) brightness of a set of splats in
    physical [x, y, z] coordinates."""
    from luxar.gsplats.utils.trils import unpack_tril

    lower = np.asarray(unpack_tril(cholesky, 3))
    cov = lower @ np.transpose(lower, (0, 2, 1))
    footprint = 2 * np.pi * np.sqrt(cov[:, 0, 0] * cov[:, 2, 2])
    cells = np.unique(np.floor(centers[:, [0, 2]] / pixel).astype(np.int64), axis=0)
    luminance = float(np.average(colors @ np.array([0.2126, 0.7152, 0.0722]), weights=amplitudes + 1e-12))
    return luminance * float((amplitudes * footprint).sum()) / (len(cells) * pixel * pixel)


def fit_region(values: np.ndarray, budget: int, quality: dict, on_pass=None):
    """Fits splats to one region's (cropped) intensity volume; returns the
    GSplatData, or None if nothing could be fitted."""
    from luxar.gsplats import fit_progressive_gaussian_splats

    budget = max(1, int(budget))
    return fit_progressive_gaussian_splats(
        np.ascontiguousarray(values, dtype=np.float32),
        max_splats=budget,
        max_splats_per_pass=min(int(quality["splatsPerPass"]), budget),
        iters_per_pass=int(quality["itersPerPass"]),
        residual_pass_min_iters=int(quality.get("residualMinIters", 500)),
        psnr_patience=0.1,
        on_pass_complete=on_pass,
        # Luxar's default floor="auto" subtracts the most common non-zero
        # intensity as "background" -- for a segment that's the segment
        # itself, leaving near-empty splats. Background is already zeroed
        # here, and a fixed 0-1 range keeps amplitudes comparable across the
        # separately fitted regions.
        floor=None,
        norm_range=(0.0, 1.0),
        verbose=False,
    )


def bbox(mask: np.ndarray, pad: int = 2) -> tuple[slice, ...]:
    nz = np.nonzero(mask)
    return tuple(slice(max(0, int(a.min()) - pad), min(n, int(a.max()) + pad + 1)) for a, n in zip(nz, mask.shape))


def build_atlas(spec: dict) -> None:
    quality = spec["quality"]
    max_dim = int(quality["maxDim"])
    total_budget = int(quality["maxSplats"])

    # --- Atlas grid: the finest volume level that fits max_dim ------------
    progress("reading volume")
    volume_ms = Multiscale(spec["volume"]["store"])
    fitting = [lv for lv in volume_ms.levels if max(lv["shape"]) <= max_dim]
    level = fitting[0] if fitting else volume_ms.levels[-1]
    volume = np.asarray(level["array"][...]).astype(np.float32)
    spacing = level["scale"].copy()
    origin = level["translation"].copy()
    if max(volume.shape) > max_dim:
        from scipy.ndimage import zoom

        factor = max_dim / max(volume.shape)
        volume = zoom(volume, factor, order=1).astype(np.float32)
        spacing = spacing / factor
    grid_shape = volume.shape
    grid_size = int(np.prod(grid_shape))
    log(f"atlas grid {grid_shape} at {spacing.round(4).tolist()} mm")

    # --- Segment coverage of each grid voxel --------------------------------
    entries = []  # atlas id - 1 -> segment info
    coverage_parts: dict = {}
    cell_volume = float(np.prod(spacing))
    voxels_per_cell: dict = {}
    for seg in spec["segmentations"]:
        for layer in seg["layers"]:
            progress(f"measuring segments: {seg['name']}, layer {layer['layer']}")
            max_value = max((s["labelValue"] for s in layer["segments"]), default=0)
            lut = np.zeros(max(256, max_value + 1), dtype=np.int32)
            for s in layer["segments"]:
                entries.append(s)
                lut[s["labelValue"]] = len(entries)
            ms = Multiscale(str(Path(seg["store"]) / f"layer{layer['layer']}"))
            # The coarsest label level at least 2x finer than the grid.
            fine = [lv for lv in ms.levels if np.all(lv["scale"] <= spacing / 2 * 1.001)]
            lv = fine[-1] if fine else ms.levels[0]
            segment_coverage(lv, grid_shape, origin, spacing, lut, coverage_parts)
            for s in layer["segments"]:
                voxels_per_cell[lut[s["labelValue"]]] = cell_volume / float(np.prod(lv["scale"]))

    # --- Intensity window and unlabeled context ------------------------------
    labeled = np.zeros(grid_size, dtype=bool)
    for atlas_id, parts in coverage_parts.items():
        for cells, _ in parts:
            labeled[cells] = True
    labeled = labeled.reshape(grid_shape)
    lo = float(np.percentile(volume, 1))
    hi = float(np.percentile(volume[labeled] if labeled.any() else volume, 99.8))
    if hi <= lo:
        hi = float(volume.max())
    if hi <= lo:
        raise SystemExit("The volume is constant at the atlas resolution; nothing to fit")
    windowed = np.clip((volume - lo) / (hi - lo), 0.0, 1.0)
    del volume
    tissue = LABELED_FLOOR + (1.0 - LABELED_FLOOR) * windowed

    # --- Budgets --------------------------------------------------------------
    sizes = {a: float(sum(c.sum() for _, c in parts)) / voxels_per_cell[a] for a, parts in coverage_parts.items()}
    sizes = {a: v for a, v in sizes.items() if v >= 0.5}  # under half a grid voxel: invisible
    context = np.zeros(grid_shape, dtype=bool)
    if spec.get("context", True):
        positive = windowed[windowed > 0]
        context = ~labeled & (windowed > otsu_threshold(positive if positive.size else windowed.ravel()))
    segment_budget = total_budget * (1.0 - (CONTEXT_BUDGET_SHARE if context.any() else 0.0))
    weights = {a: np.sqrt(v) for a, v in sizes.items()}
    total_weight = sum(weights.values()) or 1.0
    budgets = {a: max(MIN_SEGMENT_SPLATS, int(segment_budget * w / total_weight)) for a, w in weights.items()}
    if not budgets and not context.any():
        raise SystemExit("No segment or above-background tissue to fit at the atlas resolution")

    # --- Fit each segment, then the context -----------------------------------
    t0 = time.time()
    fits = []  # (atlas id, GSplatData in grid voxel coords)
    order = sorted(budgets, key=lambda a: -budgets[a])
    for k, atlas_id in enumerate(order):
        name = entries[atlas_id - 1]["name"]
        progress(f"fitting segment {k + 1}/{len(order)} ({name}, {budgets[atlas_id]:,} splats; {time.time() - t0:.0f}s)")
        cover = coverage_grid(coverage_parts.pop(atlas_id), grid_size, voxels_per_cell[atlas_id]).reshape(grid_shape)
        crop = bbox(cover > 0)
        try:
            fit = fit_region(cover[crop] * tissue[crop], budgets[atlas_id], quality)
        except Exception as e:  # a tiny or degenerate segment: skip it, don't fail the atlas
            log(f"segment {name!r}: fit failed ({e}); skipped")
            continue
        if fit is not None and len(fit.amplitudes):
            fits.append((atlas_id, fit.translate(np.array([sl.start for sl in crop], dtype=np.float64))))
    if context.any():
        progress(f"fitting unlabeled tissue ({time.time() - t0:.0f}s)")
        crop = bbox(context)
        try:
            fit = fit_region(np.where(context, CONTEXT_SCALE * windowed, 0.0)[crop], max(MIN_SEGMENT_SPLATS, int(total_budget * CONTEXT_BUDGET_SHARE)), quality)
            if len(fit.amplitudes):
                fits.append((0, fit.translate(np.array([sl.start for sl in crop], dtype=np.float64))))
        except Exception as e:
            log(f"unlabeled tissue: fit failed ({e}); skipped")
    if not fits:
        raise SystemExit("No splats could be fitted")
    log(f"fitted {sum(len(f.amplitudes) for _, f in fits):,} splats for {len(fits)} regions in {time.time() - t0:.0f}s")

    # Grid voxel [z, y, x] -> physical LPS [x, y, z] mm, for centers and
    # covariances alike.
    affine = np.zeros((4, 4))
    for out_axis, in_axis in enumerate((2, 1, 0)):
        affine[out_axis, in_axis] = spacing[in_axis]
        affine[out_axis, 3] = origin[in_axis]
    affine[3, 3] = 1.0
    fits = [(a, f.transform(affine)) for a, f in fits]

    centers = np.concatenate([f.centers for _, f in fits])
    amplitudes = np.concatenate([f.amplitudes for _, f in fits]).astype(np.float32)
    cholesky = np.concatenate([f.cholesky_factors for _, f in fits])
    splat_ids = np.concatenate([np.full(len(f.amplitudes), a, dtype=np.int64) for a, f in fits])

    colors_by_id = np.zeros((len(entries) + 1, 3), dtype=np.float32)
    colors_by_id[0] = 0.55
    names_by_id = ["Unlabeled tissue"]
    for atlas_id, s in enumerate(entries, start=1):
        colors_by_id[atlas_id] = s["color"]
        names_by_id.append(s["name"])

    # Per-segment gains (see ATLAS_EXPOSURE); the context gets CONTEXT_GAIN.
    pixel = float(spacing.min())
    brightness = {}
    for atlas_id, _ in fits:
        if atlas_id == 0:
            continue
        m = splat_ids == atlas_id
        brightness[atlas_id] = layer_brightness(centers[m], amplitudes[m], cholesky[m], colors_by_id[splat_ids[m]], pixel)
    reference = float(np.median(list(brightness.values()))) if brightness else 1.0
    gains = np.full(len(entries) + 1, 1.0, dtype=np.float32)
    gains[0] = CONTEXT_GAIN
    for atlas_id, b in brightness.items():
        gains[atlas_id] = np.clip(ATLAS_EXPOSURE * reference / max(b, 1e-12), *LAYER_GAIN_RANGE)
    amplitudes = amplitudes * gains[splat_ids]
    for atlas_id, b in brightness.items():
        m = splat_ids == atlas_id
        log(f"segment {names_by_id[atlas_id]!r}: {int(m.sum()):,} splats, brightness {b:.3g}, gain {gains[atlas_id]:.2f}")

    groups: dict[str, list[int]] = {}
    for atlas_id, s in enumerate(entries, start=1):
        groups.setdefault(s["system"], []).append(atlas_id)
    lo_xyz = np.percentile(centers, 1, axis=0)
    hi_xyz = np.percentile(centers, 99, axis=0)

    def build(compiler) -> None:
        from luxar.core.viewer_config import ViewerConfig

        scene = compiler.create_scene(
            dimensions=xyz_dimensions(),
            viewer_config=ViewerConfig(cinematic_mode=True, tone_mapping="ACES", camera=front_camera(lo_xyz, hi_xyz)),
        )
        scene.attrs["title"] = spec.get("title", "Splat atlas")

        def add_layer(name: str, mask: np.ndarray, opacity: float) -> None:
            n = int(mask.sum())
            if n == 0:
                return
            ids = splat_ids[mask]
            scene.add_gsplats(
                name=name.replace("/", "-"),
                centers=centers[mask],
                amplitudes=amplitudes[mask],
                cholesky_factors=cholesky[mask],
                colors=colors_by_id[ids],
                labels=[names_by_id[i] for i in ids],
                opacity=opacity,
                blending_mode="additive",
                layer=True,
            )
            log(f"layer {name!r}: {n:,} splats")

        for group, ids in groups.items():
            add_layer(group, np.isin(splat_ids, ids), 1.0)
        add_layer("Unlabeled tissue", splat_ids == 0, 0.35)

    progress("writing scene")
    compile_to(Path(spec["output"]), build)


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in ("meshes", "atlas"):
        raise SystemExit(__doc__)
    spec = json.loads(Path(sys.argv[2]).read_text())
    if sys.argv[1] == "meshes":
        build_meshes(spec)
    else:
        build_atlas(spec)
    progress("done")


if __name__ == "__main__":
    main()
