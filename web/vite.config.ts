import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The site is served from https://elangrr.github.io/kylix/ .
const base = '/kylix/'

// Client-side routes. GitHub Pages has no rewrite rules, so each route gets its
// own copy of index.html, and 404.html catches any other deep link.
const routes = ['app']

function staticRoutes(): Plugin {
  return {
    name: 'kylix-static-routes',
    apply: 'build',
    closeBundle() {
      const out = resolve(import.meta.dirname, 'dist')
      const index = resolve(out, 'index.html')
      for (const route of routes) {
        mkdirSync(resolve(out, route), { recursive: true })
        copyFileSync(index, resolve(out, route, 'index.html'))
      }
      copyFileSync(index, resolve(out, '404.html'))
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), staticRoutes()],
})
