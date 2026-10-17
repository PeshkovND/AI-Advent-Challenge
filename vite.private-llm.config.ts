import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-private-llm',
    rollupOptions: { input: resolve('private-llm.html') },
  },
})
