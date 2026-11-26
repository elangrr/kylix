import { usePageEntry, usePath } from './router.ts'
import { StoryPage } from './pages/StoryPage.tsx'
import { AppPlaceholder } from './pages/AppPlaceholder.tsx'
import { NotFound } from './pages/NotFound.tsx'

export function App() {
  const path = usePath()
  usePageEntry(path)
  if (path === '/') return <StoryPage />
  if (path === '/app') return <AppPlaceholder />
  return <NotFound />
}
