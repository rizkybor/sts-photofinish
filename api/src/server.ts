import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connectDb } from "./db.js";

const cfg = loadConfig();
const database = await connectDb(cfg);
const app = await buildApp(cfg, database);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await database.client.close();
    process.exit(0);
  });
}

await app.listen({ host: cfg.PF_HOST, port: cfg.PF_PORT });
