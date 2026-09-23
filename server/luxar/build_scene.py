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


def read_mesh_bin(path: str) -> tuple[np.ndarray, np.ndarray]:
    """server/src/surfaceMesh.ts's format:
    [u32 vertexCount][u32 triangleCount][f32 xyz * V][u32 abc * T]."""
    raw = np.fromfile(path, dtype=np.uint8)
    vertex_count, triangle_count = raw[:8].view(np.uint32)
    v_end = 8 + int(vertex_count) * 12
    vertices = raw[8:v_end].view(np.float32).reshape(-1, 3)
    faces = raw[v_end : v_end + int(triangle_count) * 12].view(np.uint32).reshape(-1, 3)
    return vertices, faces


def build_meshes(spec: dict) -> None:
    segments = spec["segments"]
    loaded = []
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for i, seg in enumerate(segments):
        progress(f"reading mesh {i + 1}/{len(segments)}")
        vertices, faces = read_mesh_bin(seg["file"])
        if len(faces) == 0:
            continue
        lo = np.minimum(lo, vertices.min(axis=0))
        hi = np.maximum(hi, vertices.max(axis=0))
        loaded.append((seg, vertices, faces))
    if not loaded:
        raise SystemExit("No non-empty segment meshes to compile")

    def build(compiler) -> None:
        from luxar.core.viewer_config import ViewerConfig

        scene = compiler.create_scene(
            dimensions=xyz_dimensions(),
            viewer_config=ViewerConfig(camera=front_camera(lo, hi)),
        )
        scene.attrs["title"] = spec.get("title", "Surface meshes")
        for i, (seg, vertices, faces) in enumerate(loaded):
            progress(f"compiling mesh {i + 1}/{len(loaded)} ({seg['name']}, {len(faces):,} triangles)")
            kwargs = {}
            if len(faces) > MESH_LOD_MIN_TRIANGLES:
                # 'cluster' (vertex clustering) rather than QEM: it stays fast
                # on the tens-of-millions-of-triangle surfaces micro-CT
                # segmentations produce.
                kwargs["substitutive_lod"] = {"method": "cluster"}
            scene.add_mesh(
                name=seg["layerName"],
                vertices=vertices,
                faces=faces,
                colors=tuple(float(c) for c in seg["color"]),
                labels=[seg["name"]] * len(vertices),
                shading="smooth" if len(faces) > 0 else None,
                opacity=float(seg.get("opacity", 1.0)),
                layer=True,
                **kwargs,
            )

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


def axis_index_map(n_out: int, out_origin: float, out_spacing: float, in_origin: float, in_spacing: float, n_in: int) -> tuple[np.ndarray, np.ndarray]:
    """Nearest input index along one axis for each output voxel center, and
    whether it falls inside the input."""
    idx = np.round((out_origin + np.arange(n_out) * out_spacing - in_origin) / in_spacing).astype(np.int64)
    valid = (idx >= 0) & (idx < n_in)
    return np.clip(idx, 0, n_in - 1), valid


def resample_labels_onto(grid_shape, grid_origin, grid_spacing, level, lut: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Nearest-neighbor resample of a label level onto the atlas grid, mapped
    through `lut` (label value -> atlas id). Stores are all axis-aligned LPS
    (flips are baked in at conversion), so this is separable per axis."""
    maps = [axis_index_map(grid_shape[a], grid_origin[a], grid_spacing[a], level["translation"][a], level["scale"][a], level["shape"][a]) for a in range(3)]
    data = np.asarray(level["array"][...])
    sub = data[np.ix_(maps[0][0], maps[1][0], maps[2][0])]
    inside = maps[0][1][:, None, None] & maps[1][1][None, :, None] & maps[2][1][None, None, :]
    ids = lut[np.clip(sub, 0, len(lut) - 1)] * inside
    return ids, ids > 0


# Bytes of label data read at a time when sampling splat labels from a
# segmentation's finest level.
SLAB_BYTES = 256 * 1024 * 1024


def sample_finest_labels(points_zyx_mm: np.ndarray, level, lut: np.ndarray, out: np.ndarray) -> None:
    """For each point (physical [z, y, x] mm), writes the atlas id of the
    finest-level label voxel containing it into `out`, where nonzero. Reads
    the level in z slabs so a large segmentation never loads whole."""
    idx = np.round((points_zyx_mm - level["translation"]) / level["scale"]).astype(np.int64)
    shape = np.asarray(level["shape"])
    inside = np.all((idx >= 0) & (idx < shape), axis=1)
    order = np.argsort(idx[:, 0], kind="stable")
    order = order[inside[order]]
    if len(order) == 0:
        return
    z_sorted = idx[order, 0]
    slice_bytes = int(shape[1] * shape[2] * level["array"].dtype.itemsize)
    slab = max(1, SLAB_BYTES // max(1, slice_bytes))
    z = int(z_sorted[0])
    while z <= int(z_sorted[-1]):
        lo = np.searchsorted(z_sorted, z)
        hi = np.searchsorted(z_sorted, z + slab)
        if hi > lo:
            sel = order[lo:hi]
            block = np.asarray(level["array"][z : min(z + slab, int(shape[0]))])
            values = block[idx[sel, 0] - z, idx[sel, 1], idx[sel, 2]]
            ids = lut[np.clip(values, 0, len(lut) - 1)]
            hit = ids > 0
            out[sel[hit]] = ids[hit]
        nxt = np.searchsorted(z_sorted, z + slab)
        if nxt >= len(z_sorted):
            break
        z = int(z_sorted[nxt])


# Fitted intensity of labeled voxels: LABELED_FLOOR + (1 - floor) * windowed CT.
LABELED_FLOOR = 0.4
# Fitted intensity of unlabeled context tissue: CONTEXT_SCALE * windowed CT.
CONTEXT_SCALE = 0.6
# Per-layer brightness equalization. The viewer draws each splat as a flat
# blob summed additively, so a layer's on-screen brightness grows with how
# many splats stack along a ray (bone: many small ones) and with its color's
# luminance (white bone vs dark red vessels) -- left alone, the skeleton blows
# out and vessels vanish. Each layer's gain brings its estimated brightness
# (luminance x summed splat footprint per projected area, seen from the
# front) to the median layer's, times ATLAS_EXPOSURE, within
# LAYER_GAIN_RANGE. The viewer's Layers panel can still adjust each layer.
ATLAS_EXPOSURE = 1.25
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


def build_atlas(spec: dict) -> None:
    from luxar.gsplats import fit_progressive_gaussian_splats
    from luxar.gsplats.gsplat_data import GSplatData

    quality = spec["quality"]
    max_dim = int(quality["maxDim"])

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
    log(f"atlas grid {grid_shape} at {spacing.round(4).tolist()} mm")

    # --- Atlas ids: one per (segmentation, layer, label value) -------------
    entries = []  # atlas id - 1 -> segment info
    label_grid = np.zeros(grid_shape, dtype=np.int32)
    sources = []  # (multiscale, lut) per segmentation layer, for per-splat sampling
    for si, seg in enumerate(spec["segmentations"]):
        for layer in seg["layers"]:
            progress(f"resampling labels: {seg['name']}, layer {layer['layer']}")
            max_value = max((s["labelValue"] for s in layer["segments"]), default=0)
            lut = np.zeros(max(256, max_value + 1), dtype=np.int32)
            for s in layer["segments"]:
                entries.append(s)
                lut[s["labelValue"]] = len(entries)
            ms = Multiscale(str(Path(seg["store"]) / f"layer{layer['layer']}"))
            # The coarsest label level still at least as fine as the grid.
            fine_enough = [lv for lv in ms.levels if np.all(lv["scale"] <= spacing * 1.001)]
            coarse = fine_enough[-1] if fine_enough else ms.levels[0]
            ids, hit = resample_labels_onto(grid_shape, origin, spacing, coarse, lut)
            label_grid[hit] = ids[hit]
            sources.append((ms, lut))

    # --- What gets fitted --------------------------------------------------
    # Window from the volume's background (1st percentile) up to the labeled
    # tissue's 99.8th percentile, then keep the labeled anatomy plus
    # (optionally) unlabeled tissue above an Otsu threshold as dim context;
    # air is zeroed so no splats are spent on it.
    labeled = label_grid > 0
    lo = float(np.percentile(volume, 1))
    hi = float(np.percentile(volume[labeled] if labeled.any() else volume, 99.8))
    if hi <= lo:
        hi = float(volume.max())
    if hi <= lo:
        raise SystemExit("The volume is constant at the atlas resolution; nothing to fit")
    windowed = np.clip((volume - lo) / (hi - lo), 0.0, 1.0)
    context = np.zeros_like(labeled)
    if spec.get("context", True):
        positive = windowed[windowed > 0]
        context = ~labeled & (windowed > otsu_threshold(positive if positive.size else windowed.ravel()))
    # Artistic license, as in Luxar's own CT atlas: left as-is, dense bone
    # takes nearly all of the splat budget and brightness and soft-tissue
    # segments barely show. Labeled tissue is lifted onto a floor (keeping
    # its internal texture on top) so every segment gets splats; unlabeled
    # context stays dimmer.
    fit_vol = np.where(labeled, LABELED_FLOOR + (1.0 - LABELED_FLOOR) * windowed, np.where(context, CONTEXT_SCALE * windowed, 0.0))
    fit_vol = np.ascontiguousarray(fit_vol.astype(np.float32))
    del volume, windowed
    if not (fit_vol > 0).any():
        raise SystemExit("No labeled or above-background tissue to fit at the atlas resolution")

    progress("fitting splats (pass 1)")
    t0 = time.time()

    def on_pass(pass_index, _lod, psnr) -> None:
        progress(f"fitting splats (pass {pass_index + 2}, {psnr:.1f} dB so far, {time.time() - t0:.0f}s)")

    fit: GSplatData = fit_progressive_gaussian_splats(
        fit_vol,
        max_splats=int(quality["maxSplats"]),
        max_splats_per_pass=int(quality["splatsPerPass"]),
        iters_per_pass=int(quality["itersPerPass"]),
        residual_pass_min_iters=int(quality.get("residualMinIters", 500)),
        psnr_patience=0.1,
        on_pass_complete=on_pass,
        verbose=False,
    )
    log(f"fitted {len(fit.amplitudes):,} splats in {time.time() - t0:.0f}s; amplitude p5/p50/p95 = {np.percentile(fit.amplitudes, [5, 50, 95]).round(4).tolist()}; fit_vol max {float(fit_vol.max()):.3f}, nonzero {int((fit_vol > 0).sum()):,}")

    # --- Per-splat labels ---------------------------------------------------
    # From each segmentation's FINEST level, not the coarse grid, so a splat
    # over a thin vessel still takes the vessel's color. Later segmentations
    # win where they overlap. Centers are [z, y, x] grid voxels.
    progress("sampling segment labels")
    centers_mm = origin + fit.centers * spacing
    splat_ids = np.zeros(len(fit.amplitudes), dtype=np.int64)
    for ms, lut in sources:
        sample_finest_labels(centers_mm, ms.levels[0], lut, splat_ids)

    # Grid voxel [z, y, x] -> physical LPS [x, y, z] mm, for centers and
    # covariances alike.
    affine = np.zeros((4, 4))
    for out_axis, in_axis in enumerate((2, 1, 0)):
        affine[out_axis, in_axis] = spacing[in_axis]
        affine[out_axis, 3] = origin[in_axis]
    affine[3, 3] = 1.0
    fit = fit.transform(affine)

    groups: dict[str, list[int]] = {}
    for atlas_id, s in enumerate(entries, start=1):
        groups.setdefault(s["system"], []).append(atlas_id)
    colors_by_id = np.zeros((len(entries) + 1, 3), dtype=np.float32)
    names_by_id = ["Unlabeled tissue"]
    for atlas_id, s in enumerate(entries, start=1):
        colors_by_id[atlas_id] = s["color"]
        names_by_id.append(s["name"])

    lo_xyz = np.percentile(fit.centers, 1, axis=0)
    hi_xyz = np.percentile(fit.centers, 99, axis=0)

    def build(compiler) -> None:
        from luxar.core.viewer_config import ViewerConfig

        scene = compiler.create_scene(
            dimensions=xyz_dimensions(),
            viewer_config=ViewerConfig(cinematic_mode=True, tone_mapping="ACES", camera=front_camera(lo_xyz, hi_xyz)),
        )
        scene.attrs["title"] = spec.get("title", "Splat atlas")

        def add_layer(name: str, mask: np.ndarray, opacity: float, gain: float, colors=None) -> None:
            n = int(mask.sum())
            if n == 0:
                return
            ids = splat_ids[mask]
            scene.add_gsplats(
                name=name.replace("/", "-"),
                centers=fit.centers[mask],
                amplitudes=(fit.amplitudes[mask] * gain).astype(np.float32),
                cholesky_factors=fit.cholesky_factors[mask],
                colors=colors_by_id[ids] if colors is None else colors,
                labels=[names_by_id[i] for i in ids],
                opacity=opacity,
                blending_mode="additive",
                layer=True,
            )
            log(f"layer {name!r}: {n:,} splats, gain {gain:.2f}")

        masks = {group: m for group, ids in groups.items() if (m := np.isin(splat_ids, ids)).any()}
        pixel = float(spacing.min())
        brightness = {
            g: layer_brightness(fit.centers[m], fit.amplitudes[m], fit.cholesky_factors[m], colors_by_id[splat_ids[m]], pixel) for g, m in masks.items()
        }
        reference = float(np.median(list(brightness.values()))) if brightness else 1.0
        for group, mask in masks.items():
            gain = float(np.clip(ATLAS_EXPOSURE * reference / max(brightness[group], 1e-12), *LAYER_GAIN_RANGE))
            add_layer(group, mask, 1.0, gain)
        unlabeled = splat_ids == 0
        add_layer("Unlabeled tissue", unlabeled, 0.35, 0.5, np.full((int(unlabeled.sum()), 3), 0.55, dtype=np.float32))

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
