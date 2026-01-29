import { join, sep } from "path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

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

// OG Image generation
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// Cache fonts after first load
let fontsCache: { name: string; data: ArrayBuffer; weight: number; style: "normal" | "italic" }[] | null = null;

async function loadFonts() {
  if (fontsCache) return fontsCache;

  // Fetch fonts from Google Fonts CSS API to get the actual font URLs
  const serifCssResponse = await fetch(
    "https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap",
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
  );
  const sansCssResponse = await fetch(
    "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@500&display=swap",
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
  );

  const serifCss = await serifCssResponse.text();
  const sansCss = await sansCssResponse.text();

  // Extract font URLs from CSS
  const serifUrlMatch = serifCss.match(/src:\s*url\(([^)]+)\)/);
  const sansUrlMatch = sansCss.match(/src:\s*url\(([^)]+)\)/);

  if (!serifUrlMatch || !sansUrlMatch) {
    throw new Error("Could not extract font URLs from Google Fonts CSS");
  }

  const [serifFontData, sansFontData] = await Promise.all([
    fetch(serifUrlMatch[1]).then((r) => r.arrayBuffer()),
    fetch(sansUrlMatch[1]).then((r) => r.arrayBuffer()),
  ]);

  fontsCache = [
    { name: "Instrument Serif", data: serifFontData, weight: 400, style: "normal" },
    { name: "Instrument Sans", data: sansFontData, weight: 500, style: "normal" },
  ];

  return fontsCache;
}

async function generateOgImage(): Promise<Uint8Array> {
  const fonts = await loadFonts();

  const svg = await satori(
    {
      type: "div",
      props: {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          backgroundColor: "#fafafa",
          padding: "80px",
        },
        children: [
          {
            type: "div",
            props: {
              style: {
                fontFamily: "Instrument Serif",
                fontSize: "72px",
                fontWeight: 400,
                color: "#121212",
                letterSpacing: "-0.02em",
                marginBottom: "16px",
              },
              children: "Gonzalo Zanelli",
            },
          },
          {
            type: "div",
            props: {
              style: {
                fontFamily: "Instrument Sans",
                fontSize: "28px",
                fontWeight: 500,
                color: "#666666",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              },
              children: "Software Engineer & MLOps",
            },
          },
        ],
      },
    },
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fonts,
    }
  );

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OG_WIDTH },
  });

  return resvg.render().asPng();
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

    // Handle OG image generation
    if (url.pathname === "/og.png") {
      try {
        const png = await generateOgImage();
        return secureResponse(new Blob([png], { type: "image/png" }), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch (error) {
        console.error("OG image generation error:", error);
        return secureResponse("Internal Server Error", { status: 500 });
      }
    }

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