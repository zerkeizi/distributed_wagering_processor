import { Logger } from "nestjs-pino";
import { createApp } from "./bootstrap.ts";
import { loadConfig } from "./shared/config/app-config.ts";

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port, "0.0.0.0");
app
  .get(Logger)
  .log(
    `wagering service listening on :${config.port} (roles: ${config.roles.join(",")})`,
    "Bootstrap",
  );
