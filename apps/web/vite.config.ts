import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { rmSync, writeFileSync } from 'node:fs'

const cloudflareAssetIgnore = () => ({
  name: 'cloudflare-asset-ignore',
  closeBundle() {
    rmSync(new URL('./dist/re zero arc 7 - 9', import.meta.url), {
      recursive: true,
      force: true,
    })
    writeFileSync(
      new URL('./dist/.assetsignore', import.meta.url),
      [
        'Mushoku Tensei/Mushoku Tensei Vol. 26.pdf',
        're zero arc 7 - 9/**',
        '',
      ].join('\n'),
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
