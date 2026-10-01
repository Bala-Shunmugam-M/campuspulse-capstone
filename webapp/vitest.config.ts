import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// The suite writes real rows -- reports, cases, audit events that the database
// refuses to delete -- so it must never reach a hosted database. Resolve the URL
// the way Prisma will (an exported DATABASE_URL wins over .env) and refuse
// anything that is not this machine.
const databaseUrl =
  process.env.DATABASE_URL || loadEnv("test", fileURLToPath(new URL(".", import.meta.url)), "").DATABASE_URL;
const host = (() => {
  try {
    return new URL(databaseUrl ?? "").hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  throw new Error(
    `Refusing to run tests against DATABASE_URL host "${host || "(unset)"}": tests write rows the ` +
      `database will not let you delete. Point them at local Postgres, e.g.\n` +
      `  DATABASE_URL='postgresql://compliance:localdev@localhost:5433/compliance?schema=compliance' npx vitest run`,
  );
}

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
