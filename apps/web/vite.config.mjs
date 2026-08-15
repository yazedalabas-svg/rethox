import react from "@vitejs/plugin-react";
import { writeFileSync } from "node:fs";

const cloudflareAssetIgnore = () => ({
  name: "cloudflare-asset-ignore",
  closeBundle() {
    // Cloudflare Workers rejects individual static assets larger than 25 MiB.
    // Book downloads are served through the authenticated API instead, so this
    // source PDF must not block deployments of the reader application.
    writeFileSync(
      new URL("./dist/.assetsignore", import.meta.url),
      "Mushoku Tensei/Mushoku Tensei Vol. 26.pdf\n",
    );
  },
});

export default {
  plugins: [react(), cloudflareAssetIgnore()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4181",
    },
  },
};
