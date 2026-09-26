import { ItkVtkViewerPage } from './components/ItkVtkViewerPage'

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <svg className="app-mark" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9.25" />
            <ellipse cx="12" cy="12" rx="9.25" ry="3.6" />
            <ellipse cx="12" cy="12" rx="3.6" ry="9.25" />
            <circle className="app-mark-core" cx="12" cy="12" r="2.1" />
          </svg>
          <h1>Micro-CT Visualizer</h1>
        </div>
      </header>
      <ItkVtkViewerPage />
    </div>
  )
}

export default App
