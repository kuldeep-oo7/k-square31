const { cpSync, existsSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const destination = join(root, "public");
const assets = [
  "index.html",
  "styles.css",
  "app.js",
  "watchlist-data.js",
  "grid-logic.js",
  "manifest.webmanifest",
  "k2-icon.svg",
  "service-worker.js"
];

if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const asset of assets) cpSync(join(root, asset), join(destination, asset));
