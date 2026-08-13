const { cpSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const source = join(root, ".openai", "hosting.json");
const destination = join(root, "dist", ".openai");
const serverEntry = join(root, "dist", "server", "index.js");

if (!existsSync(serverEntry)) throw new Error("vinext did not produce dist/server/index.js");
mkdirSync(destination, { recursive: true });
cpSync(source, join(destination, "hosting.json"));
