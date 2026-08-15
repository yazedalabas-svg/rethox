interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const API_ORIGIN = "https://api.rethox.online";
const PUBLIC_ORIGIN = "https://rethox.online";
const isDocumentRequest = (request: Request) =>
  request.method === "GET" && (
    request.headers.get("sec-fetch-dest") === "document" ||
    request.headers.get("accept")?.includes("text/html") === true
  );

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);

    if (incoming.pathname === "/api" || incoming.pathname.startsWith("/api/")) {
      const upstream = new URL(incoming.pathname + incoming.search, API_ORIGIN);
      const headers = new Headers(request.headers);
      headers.set("x-rethox-public-origin", PUBLIC_ORIGIN);
      headers.set("x-forwarded-host", incoming.host);
      headers.set("x-forwarded-proto", "https");

      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
      }

      return fetch(new Request(upstream, init));
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404 || !isDocumentRequest(request)) return assetResponse;

    // The reader is a React SPA: direct links such as `/support` must load
    // the application entry point, then React Router selects the page.  Do
    // not apply this fallback to asset/API requests, which must keep 404s.
    return env.ASSETS.fetch(new Request(new URL("/", incoming), request));
  },
};
