import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
  componentStack: string
}

/**
 * Catches a render error anywhere in the app and shows it, instead of React
 * unmounting everything and leaving a blank page -- so a crash says what
 * went wrong (and can be reported) and the page can be reloaded from there.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('App crashed:', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? '' })
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children
    const details = `${error.name}: ${error.message}\n${error.stack ?? ''}\n\nComponent stack:${componentStack}`
    return (
      <div className="crash-screen">
        <h2>Something went wrong</h2>
        <p>The viewer hit an error and stopped. Reloading usually recovers; your uploads are safe on the server.</p>
        <pre className="crash-details">{details}</pre>
        <div className="crash-actions">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className="btn btn-secondary" onClick={() => void navigator.clipboard?.writeText(details)}>
            Copy error
          </button>
        </div>
      </div>
    )
  }
}
