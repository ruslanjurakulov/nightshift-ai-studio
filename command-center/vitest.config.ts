import path from "node:path";
import { defineConfig } from "vitest/config";

// The intelligence derivations are pure functions over Supabase row shapes, so
// they run in a plain node environment — no DOM or network needed. The few
// tests that mount a component (tests/*.test.tsx) opt into jsdom with a
// `// @vitest-environment jsdom` docblock instead of changing the default.
export default defineConfig({
  // tsconfig says `jsx: preserve` (Next compiles it); the test transform must not.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": path.resolve(process.cwd()) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
