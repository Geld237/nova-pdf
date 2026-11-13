import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initUpdates } from './update'
import { interceptExternalLinks, isNative } from './platform'

initUpdates()
interceptExternalLinks()
if (isNative) document.documentElement.classList.add('native')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
