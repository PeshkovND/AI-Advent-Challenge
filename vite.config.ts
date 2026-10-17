import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': `http://127.0.0.1:${process.env.PORT || loadEnv(mode, process.cwd(), '').PORT || '8787'}`,
    },
  },
  preview: { host: '127.0.0.1' },
}))
