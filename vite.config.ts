import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist/frontend" },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEBCARDS_DEV_PORT || 3000),
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${process.env.PORT || "3001"}` },
  },
});
