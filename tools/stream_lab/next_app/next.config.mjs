// Lab-only scratch app (tools/stream_lab). `compress` stays at Next's default (on), as in
// command-center/next.config.ts, because Next's own gzip is one of the hops being measured.
// NEXT_OUTPUT=standalone as in command-center/Dockerfile, so the server production runs
// (`node server.js`) can be measured beside `next start`.
export default {
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  async headers() {
    return [
      {
        source: "/api/cfg/turn",
        headers: [
          { key: "Cache-Control", value: "no-transform" },
          { key: "X-Accel-Buffering", value: "no" },
        ],
      },
    ];
  },
};
