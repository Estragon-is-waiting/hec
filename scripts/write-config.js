import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error("Définissez SUPABASE_URL et SUPABASE_ANON_KEY avant le build.");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const body = `window.HEC_CONFIG = ${JSON.stringify(
  { SUPABASE_URL: url, SUPABASE_ANON_KEY: key },
  null,
  2,
)};\n`;

const publicDir = join(root, "public");
mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, "config.js"), body);
copyFileSync(join(root, "index.html"), join(publicDir, "index.html"));
copyFileSync(join(root, "app.js"), join(publicDir, "app.js"));
copyFileSync(join(root, "repartition.json"), join(publicDir, "repartition.json"));
console.log("config.js écrit dans public/.");
