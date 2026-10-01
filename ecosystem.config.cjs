// PM2: satu perintah untuk menyalakan seluruh Photo Finish di lokasi lomba.
//   npm run prod:start | prod:stop | prod:restart | prod:status | prod:logs
// MongoDB ikut dijalankan kecuali PF_PM2_MONGO=off (mis. memakai MongoDB lain).
// Agent kamera ikut dijalankan kecuali PF_PM2_AGENT=off (mis. kamera di mesin lain).
const fs = require("fs");
const path = require("path");

function readEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
  } catch {
    /* .env belum ada — scripts/setup.sh membuatnya */
  }
  return env;
}

const env = readEnv();
const on = (key) => (env[key] || "on").toLowerCase() !== "off";
const common = { cwd: __dirname, interpreter: "bash", autorestart: true, restart_delay: 3000, max_restarts: 50, time: true };

module.exports = {
  apps: [
    on("PF_PM2_MONGO") && { ...common, name: "pf-mongo", script: "scripts/run-mongo.sh" },
    { ...common, name: "pf-api", script: "scripts/run-api.sh" },
    on("PF_PM2_AGENT") && { ...common, name: "pf-agent", script: "scripts/run-agent.sh" },
  ].filter(Boolean),
};
