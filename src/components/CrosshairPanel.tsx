import type { CrosshairInfo } from '../types'

interface CrosshairPanelProps {
  crosshair: CrosshairInfo | null
}

export function CrosshairPanel({ crosshair }: CrosshairPanelProps) {
  if (!crosshair) return null

  return (
    <section className="panel">
      <h2 className="panel-title">Cursor</h2>
      <div className="crosshair-mm">
        {crosshair.mm[0]}, {crosshair.mm[1]}, {crosshair.mm[2]} mm
      </div>
      <ul className="crosshair-values">
        {crosshair.values.map((v, i) => (
          <li key={`${v.name}-${i}`}>
            <span className="crosshair-name" title={v.name}>
              {v.name}
            </span>
            <span className="crosshair-value">{Number.isFinite(v.value) ? v.value.toFixed(2) : '—'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
