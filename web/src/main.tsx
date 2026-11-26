import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/marcellus/latin-400.css'
import '@fontsource/alegreya/latin-400.css'
import '@fontsource/alegreya/latin-400-italic.css'
import '@fontsource/alegreya/latin-700.css'
import '@fontsource/alegreya-sans-sc/latin-500.css'
import './styles/global.css'
import { App } from './App.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
