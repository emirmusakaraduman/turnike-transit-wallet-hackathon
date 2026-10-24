import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Serves the api/*.ts handlers during `vite dev`, so the app runs on localhost without Vercel. */
function localApi(): Plugin {
  return {
    name: "turnike-local-api",
    configureServer(server) {
      Object.assign(process.env, loadEnv("development", process.cwd(), ""));
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const m = /^\/api\/([a-z]+)$/.exec(url.pathname);
        if (!m) return next();
        try {
          const mod = await server.ssrLoadModule(`/api/${m[1]}.ts`);
          let raw = "";
          for await (const c of req) raw += c;
          let body: unknown = raw;
          try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep raw */ }
          const out = {
            status(c: number) { res.statusCode = c; return out; },
            json(b: unknown) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); },
          };
          await mod.default({ method: req.method, query: Object.fromEntries(url.searchParams), body, headers: req.headers }, out);
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localApi()],
  test: {
    environment: "node",
    env: { VITE_TURNIKE_ADDRESS: "0x0000000000000000000000000000000000000000", VITE_RPC_URL: "" }, setupFiles: ["./tests/setup.ts"], include: ["tests/**/*.test.ts"] },
} as Parameters<typeof defineConfig>[0]);
