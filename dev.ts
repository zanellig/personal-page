import { watch } from "node:fs";
import { serve } from "@hono/node-server";
import { $ } from "bun";
import app from "./index";

const port = process.env.PORT ?? 3000;
const CSS_INPUT = "public/index.css";
const CSS_OUTPUT = "public/output.css";

serve({
	fetch: app.fetch,
	port: Number(port),
});

console.log(`Server running at http://localhost:${port}`);

function minifyCss() {
	console.log("Minifying CSS...");
	$`bun run esbuild ${CSS_INPUT} --minify --outfile=${CSS_OUTPUT}`
		.then(() => console.log("CSS minified"))
		.catch((err) => console.error("\x1b[31mMinification failed.\x1b[0m", err));
}

// Initial minification
minifyCss();

// Watch for changes
watch(CSS_INPUT, (eventType) => {
	if (eventType === "change") {
		minifyCss();
	}
});

console.log(`Watching ${CSS_INPUT} for changes...`);
