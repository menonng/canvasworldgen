import { defineConfig } from "vite";

// GitHub Pages serves the site from /<repo>/, so assets need that base.
// Override with BASE_PATH=/ when serving from a domain root.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/mineworldgen/",
  build: { target: "es2022", outDir: "dist" },
  worker: { format: "es" },
});
