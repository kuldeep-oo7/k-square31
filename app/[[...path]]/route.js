export const dynamic = "force-dynamic";

export async function GET(request, context) {
  const path = (await context.params).path || [];
  if (!path.length) return Response.redirect(new URL("/index.html", request.url), 307);
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
