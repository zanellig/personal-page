import { serve } from "@hono/node-server";
import app from "./index";

const port = process.env.PORT ?? 3000;

serve({
  fetch: app.fetch,
  port: Number(port),
});

console.log(`Server running at http://localhost:${port}`);
