import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The suite imports application code that uses the "@/" alias from tsconfig.
// Vitest does not read tsconfig paths, so the alias is repeated here.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // The database-backed tests share one Postgres instance; running files in
    // parallel makes their audit rows race.
    fileParallelism: false,
  },
});
