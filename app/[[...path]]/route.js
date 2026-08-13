import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assets = new Map([
  ["", [() => readFile(join(process.cwd(), "index.html")), "index.html", "text/html; charset=utf-8"]],
  ["index.html", [() => readFile(join(process.cwd(), "index.html")), "index.html", "text/html; charset=utf-8"]],
  ["styles.css", [() => readFile(join(process.cwd(), "styles.css")), "styles.css", "text/css; charset=utf-8"]],
  ["app.js", [() => readFile(join(process.cwd(), "app.js")), "app.js", "text/javascript; charset=utf-8"]],
  ["watchlist-data.js", [() => readFile(join(process.cwd(), "watchlist-data.js")), "watchlist-data.js", "text/javascript; charset=utf-8"]],
  ["grid-logic.js", [() => readFile(join(process.cwd(), "grid-logic.js")), "grid-logic.js", "text/javascript; charset=utf-8"]],
  ["manifest.webmanifest", [() => readFile(join(process.cwd(), "manifest.webmanifest")), "manifest.webmanifest", "application/manifest+json"]],
  ["k2-icon.svg", [() => readFile(join(process.cwd(), "k2-icon.svg")), "k2-icon.svg", "image/svg+xml"]],
  ["service-worker.js", [() => readFile(join(process.cwd(), "service-worker.js")), "service-worker.js", "text/javascript; charset=utf-8"]]
]);

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
};

export async function GET(_request, context) {
  const segments = (await context.params).path || [];
  const key = segments.join("/");
  const asset = assets.get(key);
  if (!asset) return new Response("Not found", { status: 404, headers: securityHeaders });
  const [load, filename, contentType] = asset;
  const body = await load();
  const cacheControl = filename === "index.html" || filename === "service-worker.js"
    ? "private, no-store, max-age=0, must-revalidate"
    : "public, max-age=300, must-revalidate";
  return new Response(body, {
    headers: {
      ...securityHeaders,
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      ...(filename === "service-worker.js" ? { "Service-Worker-Allowed": "/" } : {})
    }
  });
}
