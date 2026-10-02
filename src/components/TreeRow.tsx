import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TreeRowProps {
  depth: number
  label: string
  color?: string
  checked: boolean
  indeterminate?: boolean
  opacity: number
  onToggle: (checked: boolean) => void
  onOpacityChange: (opacity: number) => void
  onRemove?: () => void
  badge?: string
  /** Group rows (files, systems): whether their children show. Leaf rows
   *  leave it undefined and get a spacer so labels stay aligned. */
  expanded?: boolean
  onExpandToggle?: () => void
}

export const TreeRow = memo(function TreeRow({
  depth,
  label,
  color,
  checked,
  indeterminate,
  opacity,
  onToggle,
  onOpacityChange,
  onRemove,
  badge,
  expanded,
  onExpandToggle
}: TreeRowProps) {
  const [hovered, setHovered] = useState(false)
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 })
  const rowRef = useRef<HTMLDivElement | null>(null)
  const hideTimer = useRef<number | null>(null)
  const draggingRef = useRef(false)

  const show = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect) {
      const popoverWidth = 180
      const overflowsRight = rect.right + 8 + popoverWidth > window.innerWidth
      setPopoverPos({
        top: rect.top,
        left: overflowsRight ? rect.left - popoverWidth - 8 : rect.right + 8
      })
    }
    setHovered(true)
  }, [])

  const scheduleHide = useCallback(() => {
    // Dragging the slider can easily move the pointer outside the popover's
    // small hit area — don't let that abort the drag by unmounting it.
    if (draggingRef.current) return
    hideTimer.current = window.setTimeout(() => setHovered(false), 200)
  }, [])

  useEffect(() => {
    const onPointerUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      scheduleHide()
    }
    window.addEventListener('pointerup', onPointerUp)
    return () => window.removeEventListener('pointerup', onPointerUp)
  }, [scheduleHide])

  const checkboxRef = useCallback(
    (el: HTMLInputElement | null) => {
      if (el) el.indeterminate = Boolean(indeterminate)
    },
    [indeterminate]
  )

  return (
    <div ref={rowRef} className="tree-row" style={{ paddingLeft: depth * 16 }} onMouseEnter={show} onMouseLeave={scheduleHide}>
      {onExpandToggle ? (
        <button
          className={expanded ? 'tree-chevron expanded' : 'tree-chevron'}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          onClick={onExpandToggle}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4.5 2.5 8 6l-3.5 3.5" />
          </svg>
        </button>
      ) : (
        <span className="tree-chevron-spacer" />
      )}
      <input ref={checkboxRef} type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
      {color && <span className="color-swatch" style={{ background: color }} />}
      <span
        className={onExpandToggle ? 'tree-label tree-label-group' : 'tree-label'}
        title={label}
        onClick={onExpandToggle}
      >
        {label}
      </span>
      {badge && <span className="tree-badge">{badge}</span>}
      {onRemove && (
        <button
          className="icon-btn"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          Remove
        </button>
      )}

      {hovered &&
        createPortal(
          <div
            className="opacity-popover"
            style={{ top: popoverPos.top, left: popoverPos.left }}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            <div className="opacity-popover-label">
              Opacity <b>{Math.round(opacity * 100)}%</b>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={opacity}
              onPointerDown={() => {
                draggingRef.current = true
                if (hideTimer.current !== null) {
                  window.clearTimeout(hideTimer.current)
                  hideTimer.current = null
                }
              }}
              onChange={(e) => onOpacityChange(Number(e.target.value))}
            />
          </div>,
          document.body
        )}
    </div>
  )
})
