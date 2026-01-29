import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { join, sep } from "path";
import { readdir, stat } from "node:fs/promises";
import satori, { type Font } from "satori";
import { Resvg } from "@resvg/resvg-js";

const app = new Hono();

const PUBLIC_DIR = join(import.meta.dir, "public");
const MAX_URI_LENGTH = 2048;

// Security headers middleware
app.use(
  "*",
  secureHeaders({
    xContentTypeOptions: "nosniff",
    xFrameOptions: "DENY",
    referrerPolicy: "strict-origin-when-cross-origin",
  })
);

// Method restriction middleware (only GET and HEAD)
app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
  }
  return next();
});

// URI length validation middleware
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.length > MAX_URI_LENGTH) {
    return c.text("URI Too Long", 414);
  }
  return next();
});

// OG Image generation
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// Cache fonts after first load
let fontsCache: Font[] | null = null;

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
    fetch(serifUrlMatch[1]!).then((r) => r.arrayBuffer()),
    fetch(sansUrlMatch[1]!).then((r) => r.arrayBuffer()),
  ]);

  fontsCache = [
    { name: "Instrument Serif", data: serifFontData, weight: 400 as const, style: "normal" },
    { name: "Instrument Sans", data: sansFontData, weight: 500 as const, style: "normal" },
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

// OG image route
app.get("/og.png", async (c) => {
  try {
    const png = await generateOgImage();
    return c.body(png as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    });
  } catch (error) {
    console.error("OG image generation error:", error);
    return c.text("Internal Server Error", 500);
  }
});

// XML entity escaping for sitemap URLs
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Sitemap route
app.get("/sitemap.xml", async (c) => {
  try {
    // Use request origin for dynamic base URL
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    
    const files = await readdir(PUBLIC_DIR, { recursive: true });

    // Filter HTML files and get their stats
    const htmlFiles = files.filter((f) => f.endsWith(".html"));
    
    const entries = await Promise.all(
      htmlFiles.map(async (f) => {
        const normalized = f.replace(/\\/g, "/");
        const filePath = join(PUBLIC_DIR, f);
        
        // Get actual file modification time
        const fileStat = await stat(filePath);
        const lastmod = fileStat.mtime.toISOString().split("T")[0];
        
        // Convert file path to URL path
        let urlPath: string;
        if (normalized === "index.html") {
          urlPath = "/";
        } else if (normalized.endsWith("/index.html")) {
          // Subdirectory with index.html: /about/index.html -> /about/
          urlPath = "/" + normalized.replace(/\/index\.html$/, "/");
        } else {
          // Regular HTML file: /about.html -> /about
          urlPath = "/" + normalized.replace(/\.html$/, "");
        }
        
        const fullUrl = escapeXml(baseUrl + urlPath);
        const priority = urlPath === "/" ? "1.0" : "0.8";
        
        return `  <url>
    <loc>${fullUrl}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>${priority}</priority>
  </url>`;
      })
    );

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>`;

    return c.body(sitemap, 200, {
      "Content-Type": "application/xml",
      "Cache-Control": "public, max-age=86400",
    });
  } catch (error) {
    console.error("Sitemap generation error:", error);
    return c.text("Internal Server Error", 500);
  }
});

// Path traversal protection middleware for static files
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = join(PUBLIC_DIR, pathname);

  // Prevent directory traversal attacks
  if (!filePath.startsWith(PUBLIC_DIR + sep)) {
    return c.text("Forbidden", 403);
  }

  return next();
});

// Static file serving (for local development)
app.use("*", serveStatic({ root: "./public" }));

// Fallback 404
app.notFound((c) => c.text("Not Found", 404));

// Export for Vercel and imports
export default app;