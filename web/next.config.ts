import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// The production build is a pure static export served by FastAPI.
// `rewrites` are not allowed together with `output: "export"` (not even in
// dev), so the config depends on the phase: in `next dev` we proxy /api to the
// local FastAPI server and do not export.
const API_ORIGIN = `http://127.0.0.1:${process.env.DOCS_VIEWER_PORT ?? "8765"}`;

const base: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Only these Host headers may use the dev /api proxy. A DNS-rebinding page
// (evil.example -> 127.0.0.1) sends its own Host, gets no rewrite and so a 404;
// FastAPI also checks X-Forwarded-Host as a second line of defence.
const DEV_HOST = "(?:127\\.0\\.0\\.1|localhost)";

// Same policy FastAPI sends in production, plus what `next dev` itself needs
// (React refresh uses eval; HMR uses a same-origin websocket).
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      ...base,
      // gzip would buffer the proxied /api/events SSE stream in dev.
      compress: false,
      async rewrites() {
        return [
          {
            source: "/api/:path*",
            has: [{ type: "host", value: DEV_HOST }],
            destination: `${API_ORIGIN}/api/:path*`,
          },
        ];
      },
      async headers() {
        return [
          {
            source: "/:path*",
            headers: [
              { key: "Content-Security-Policy", value: DEV_CSP },
              { key: "Referrer-Policy", value: "no-referrer" },
              { key: "X-Content-Type-Options", value: "nosniff" },
            ],
          },
        ];
      },
    };
  }
  return { ...base, output: "export" };
}
