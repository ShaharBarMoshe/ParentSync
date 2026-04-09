import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './scss/main.scss'
import App from './App.tsx'
import { initElectronApi } from './services/api'

// Initialize Electron API base URL before rendering
initElectronApi().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
