const { cpSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const source = join(root, ".openai", "hosting.json");
const destination = join(root, "dist", ".openai");
const serverEntry = ["index.mjs", "index.js"].map((name) => join(root, "dist", "server", name)).find(existsSync);

if (!serverEntry) throw new Error("vinext did not produce a server entry (index.mjs or index.js)");
mkdirSync(destination, { recursive: true });
cpSync(source, join(destination, "hosting.json"));
