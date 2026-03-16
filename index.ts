import { serveStatic } from "@hono/node-server/serve-static";
import { Resvg } from "@resvg/resvg-js";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { join, sep } from "path";
import satori, { type Font } from "satori";

const app = new Hono();

const PUBLIC_DIR = join(import.meta.dir, "public");
const MAX_URI_LENGTH = 2048;

// in-memory cache for OG image
let ogImageCache: Uint8Array | null = null;
// in-memory cache for sitemap
let sitemapCache: string | null = null;
// in-memory cache for fonts
let fontsCache: Font[] | null = null;

// Security headers middleware
app.use(
	"*",
	secureHeaders({
		xContentTypeOptions: "nosniff",
		xFrameOptions: "DENY",
		referrerPolicy: "strict-origin-when-cross-origin",
		strictTransportSecurity: "max-age=31536000; includeSubDomains",
		permissionsPolicy: {
			camera: [],
			microphone: [],
			geolocation: [],
		},
	}),
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

async function loadFonts() {
	if (fontsCache) return fontsCache;

	// Look for fonts next to the api entry point (works on Vercel)
	// Falls back to public/fonts for local dev
	const apiDir = join(import.meta.dir, "api/fonts");
	const publicDir = join(import.meta.dir, "public/fonts");

	const fontsDir = (await Bun.file(
		join(apiDir, "instrument-serif-v5-latin-regular.woff2"),
	).exists())
		? apiDir
		: publicDir;

	const [serifFontData, sansFontData] = await Promise.all([
		Bun.file(
			join(fontsDir, "instrument-serif-v5-latin-regular.woff2"),
		).arrayBuffer(),
		Bun.file(
			join(fontsDir, "instrument-sans-v4-latin-500.woff2"),
		).arrayBuffer(),
	]);

	fontsCache = [
		{
			name: "Instrument Serif",
			data: serifFontData,
			weight: 400 as const,
			style: "normal",
		},
		{
			name: "Instrument Sans",
			data: sansFontData,
			weight: 500 as const,
			style: "normal",
		},
	];

	return fontsCache;
}

async function generateOgImage(): Promise<Uint8Array> {
	if (ogImageCache) return ogImageCache;

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
		},
	);

	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: OG_WIDTH },
	});

	ogImageCache = resvg.render().asPng();

	return ogImageCache;
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

// Define sitemap routes explicitly (Vercel doesn't expose public dir to functions)
const SITEMAP_ROUTES: Array<{
	path: string;
	priority: string;
	changefreq: string;
}> = [{ path: "/", priority: "1.0", changefreq: "monthly" }];

// Sitemap route
app.get("/sitemap.xml", (c) => {
	if (sitemapCache)
		return c.body(sitemapCache, 200, {
			"Content-Type": "application/xml",
			"Cache-Control": "public, max-age=86400",
		});

	const url = new URL(c.req.url);
	const baseUrl = `${url.protocol}//${url.host}`;
	const today = new Date().toISOString().split("T")[0];

	const entries = SITEMAP_ROUTES.map(({ path, priority, changefreq }) => {
		const fullUrl = escapeXml(baseUrl + path);
		return `  <url>
    <loc>${fullUrl}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
	}).join("\n");

	const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;

	sitemapCache = sitemap;

	return c.body(sitemap, 200, {
		"Content-Type": "application/xml",
		"Cache-Control": "public, max-age=86400",
	});
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

// Cache control middleware for static files
app.use("*", async (c, next) => {
	await next();
	if (c.res.status === 200) {
		const path = c.req.path;
		if (path === "/" || path.endsWith(".html")) {
			c.header("Cache-Control", "public, max-age=0, must-revalidate");
		} else if (
			path.endsWith(".css") ||
			path.endsWith(".ico") ||
			path.endsWith(".svg") ||
			path.endsWith(".woff2")
		) {
			c.header("Cache-Control", "public, max-age=86400");
		}
	}
});

// Static file serving (for local development)
app.use("*", serveStatic({ root: "./public" }));

// Fallback 404
app.notFound((c) => c.text("Not Found", 404));

// Export for Vercel and imports
export default app;
