import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Audience } from './components/Audience'
import { initUpdates } from './update'
import { interceptExternalLinks, isNative } from './platform'

initUpdates()
import('./fonts').then((m) => m.initFonts())
// Diagnostic de l'IA accessible depuis la console (aide au dépannage)
;(window as unknown as { __novaDiag?: () => Promise<unknown> }).__novaDiag = async () => {
  const llm = await import('./ai/llm')
  const diag = await llm.aiDiagnostics('http://localhost:11434')
  // petit essai de réponse avec le moteur automatique
  const answer = await llm.chat({ ...llm.DEFAULT_AI }, [{ role: 'user', content: 'Bonjour' }], () => {}, () => {}).catch((e) => `ERREUR ${e}`)
  return { ...diag, engine: llm.lastEngine(), answer: String(answer).slice(0, 60) }
}
interceptExternalLinks()
if (isNative) document.documentElement.classList.add('native')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {new URLSearchParams(location.search).has('audience') ? <Audience /> : <App />}
  </StrictMode>,
)
