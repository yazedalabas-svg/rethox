interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const API_ORIGIN = "https://api.rethox.online";
const PUBLIC_ORIGIN = "https://rethox.online";

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

    return env.ASSETS.fetch(request);
  },
};
