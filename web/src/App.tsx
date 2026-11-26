import { usePageEntry, usePath } from './router.ts'
import { StoryPage } from './pages/StoryPage.tsx'
import { TradePage } from './pages/TradePage.tsx'
import { NotFound } from './pages/NotFound.tsx'

export function App() {
  const path = usePath()
  usePageEntry(path)
  if (path === '/') return <StoryPage />
  if (path === '/app') return <TradePage />
  return <NotFound />
}
