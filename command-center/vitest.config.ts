import path from "node:path";
import { defineConfig } from "vitest/config";

// The intelligence derivations are pure functions over Supabase row shapes, so
// they run in a plain node environment — no DOM or network needed.
export default defineConfig({
  // Component tests render .tsx to static markup; Next compiles JSX with the
  // automatic runtime, so do the same here (no `import React` in components).
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": path.resolve(process.cwd()) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
