import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash]-r2.js",
      },
    },
  },
  server: {
    port: 5173,
    allowedHosts: [".loca.lt", ".lhr.life"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4181",
        changeOrigin: true,
      },
    },
  },
});
