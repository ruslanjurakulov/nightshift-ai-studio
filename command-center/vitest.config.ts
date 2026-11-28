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
    alias: {
      "@": path.resolve(process.cwd()),
      // `server-only` throws unless the bundler resolves it for React Server Components, which a test runner never does. The
      // showcase manifest (lib/site/showcase.ts) is server-only and reached by some fifty page and component tests; one alias
      // here instead of a vi.mock in each. The build still enforces the guard (`next build` fails on a client import of it).
      "server-only": path.resolve(process.cwd(), "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    // lib/**: unit tests that sit next to their module (lib/agent-*.test.ts, lib/server/agent-provider-adapters.test.ts).
    include: ["tests/**/*.test.{ts,tsx}", "lib/**/*.test.ts"],
  },
});
