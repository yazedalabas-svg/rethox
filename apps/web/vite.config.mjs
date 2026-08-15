import react from "@vitejs/plugin-react";
import { rmSync, writeFileSync } from "node:fs";

const cloudflareAssetIgnore = () => ({
  name: "cloudflare-asset-ignore",
  closeBundle() {
    // These source documents are imported into the API data and optimized
    // cover/illustration folders. They must never be copied to the public site.
    rmSync(new URL("./dist/re zero arc 7 - 9", import.meta.url), {
      recursive: true,
      force: true,
    });
    // Cloudflare Workers rejects individual static assets larger than 25 MiB.
    // Book downloads are served through the authenticated API instead, so this
    // source PDF must not block deployments of the reader application.
    writeFileSync(
      new URL("./dist/.assetsignore", import.meta.url),
      [
        "Mushoku Tensei/Mushoku Tensei Vol. 26.pdf",
        "re zero arc 7 - 9/**",
        "",
      ].join("\n"),
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
