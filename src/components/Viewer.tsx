interface ViewerProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
}

export function Viewer({ canvasRef }: ViewerProps) {
  return (
    <div className="viewer">
      <canvas ref={canvasRef} className="viewer-canvas" />
    </div>
  )
}
