import authHandler from "../../../api/auth";
import portfolioHandler from "../../../api/portfolio";
import marketHandler from "../../../api/market";
import gmSyncHandler from "../../../api/gm-sync";
import aiHandler from "../../../api/ai";
import aiRunHandler from "../../../api/ai-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handlers = {
  auth: authHandler,
  portfolio: portfolioHandler,
  market: marketHandler,
  "gm-sync": gmSyncHandler,
  ai: aiHandler,
  "ai-run": aiRunHandler
};

function requestHeaders(request) {
  const headers = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return headers;
}

async function nodeRequest(request) {
  const url = new URL(request.url);
  let body = {};
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.text();
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
  }
  return {
    method: request.method,
    headers: requestHeaders(request),
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    socket: { remoteAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0" }
  };
}

function nodeResponse() {
  const headers = new Headers();
  let status = 200;
  let payload = null;
  const response = {
    setHeader(name, value) {
      headers.delete(name);
      const values = Array.isArray(value) ? value : [value];
      values.forEach((item) => headers.append(name, String(item)));
      return response;
    },
    getHeader(name) { return headers.get(name); },
    status(code) { status = code; return response; },
    json(value) {
      headers.set("Content-Type", "application/json; charset=utf-8");
      payload = JSON.stringify(value);
      return response;
    },
    send(value) { payload = value == null ? null : String(value); return response; },
    end(value) { payload = value == null ? null : String(value); return response; },
    result() { return new Response(payload, { status, headers }); }
  };
  return response;
}

async function dispatch(request, context) {
  const { endpoint } = await context.params;
  const handler = handlers[endpoint];
  if (!handler) return Response.json({ error: "Not found" }, { status: 404 });
  const response = nodeResponse();
  await handler(await nodeRequest(request), response);
  return response.result();
}

export const GET = dispatch;
export const POST = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
