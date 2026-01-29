import { join, sep } from "path";

const PUBLIC_DIR = join(import.meta.dir, "public");
const MAX_URI_LENGTH = 2048;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function secureResponse(body: string | Blob | null, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: { ...SECURITY_HEADERS, ...init?.headers },
  });
}

const server = Bun.serve({
  port: process.env.PORT ?? 3000,
  async fetch(request) {
    // Only allow GET and HEAD methods
    if (request.method !== "GET" && request.method !== "HEAD") {
      return secureResponse("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);

    // Reject excessively long URIs
    if (url.pathname.length > MAX_URI_LENGTH) {
      return secureResponse("URI Too Long", { status: 414 });
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = join(PUBLIC_DIR, pathname);

    // Prevent directory traversal attacks
    if (!filePath.startsWith(PUBLIC_DIR + sep)) {
      return secureResponse("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    if (await file.exists()) {
      return secureResponse(file);
    }

    return secureResponse("Not Found", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${server.port}`);