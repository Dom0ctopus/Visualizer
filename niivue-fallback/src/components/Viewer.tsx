interface ViewerProps {
  canvas2dRef: React.RefObject<HTMLCanvasElement | null>
  canvas3dRef: React.RefObject<HTMLCanvasElement | null>
  canvas3dDisplayRef: React.RefObject<HTMLCanvasElement | null>
}

export function Viewer({ canvas2dRef, canvas3dRef, canvas3dDisplayRef }: ViewerProps) {
  return (
    <div className="viewer">
      <canvas ref={canvas2dRef} className="viewer-canvas" />
      {/* nv3d's real, niivue-managed canvas -- kept off-screen (see .viewer-3d-source
          in index.css) and mirrored onto the plain 2D canvas below every frame. See
          the comment on canvas3dRef in useNiivue.ts for why. */}
      <div className="viewer-3d-source">
        <canvas ref={canvas3dRef} className="viewer-canvas" />
      </div>
      <canvas ref={canvas3dDisplayRef} className="viewer-canvas viewer-3d-display" />
    </div>
  )
}
