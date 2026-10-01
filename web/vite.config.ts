import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const api = process.env.PF_API_URL ?? "http://127.0.0.1:4100";

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true, // bisa dibuka dari tablet juri di LAN
    proxy: {
      "/api": api,
      "/files": api,
      "/socket.io": { target: api, ws: true },
    },
  },
});
