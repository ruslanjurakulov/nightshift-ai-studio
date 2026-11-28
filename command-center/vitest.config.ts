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
    projects: [
      {
        extends: true,
        // lib/**: unit tests that sit next to their module (lib/agent-*.test.ts, lib/server/agent-provider-adapters.test.ts).
        test: { name: "unit", include: ["tests/**/*.test.{ts,tsx}", "lib/**/*.test.ts"] },
      },
      {
        // The parity suite (docs/studio/LIVE_CREATION_PLAN.md §3.11, tests/helpers/brainStreamParity.ts): the brain's route tests
        // once more, with every POST /api/brain/turn asked as a stream and its `end` read as the answer.
        extends: true,
        test: {
          name: "brain-stream",
          include: ["tests/brain-*.test.ts", "tests/security-brain-*.test.ts"],
          env: { BRAIN_PARITY_MODE: "stream" },
        },
      },
    ],
  },
});
