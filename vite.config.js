import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // В режиме разработки — проксируем /api на localhost:3000 (vercel dev)
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
