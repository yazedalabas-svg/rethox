import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'node:fs'

const cloudflareAssetIgnore = () => ({
  name: 'cloudflare-asset-ignore',
  closeBundle() {
    writeFileSync(
      new URL('./dist/.assetsignore', import.meta.url),
      'Mushoku Tensei/Mushoku Tensei Vol. 26.pdf\n',
    )
  },
})

export default defineConfig({
  plugins: [
    react(),
    cloudflareAssetIgnore(),
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4181',
    },
  },
})
