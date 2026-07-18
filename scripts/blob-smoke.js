const crypto = require("node:crypto");
const { del, get, put } = require("@vercel/blob");

async function streamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function run() {
  const pathname = `qa/k2-smoke-${crypto.randomUUID()}.json`;
  try {
    const created = await put(pathname, JSON.stringify({ stage: 1 }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json"
    });
    const first = await get(pathname, { access: "private", useCache: false });
    if (!first || JSON.parse(await streamText(first.stream)).stage !== 1) throw new Error("Private read failed");
    await put(pathname, JSON.stringify({ stage: 2 }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      ifMatch: first.blob.etag,
      contentType: "application/json"
    });
    const second = await get(pathname, { access: "private", useCache: false });
    if (!second || JSON.parse(await streamText(second.stream)).stage !== 2) throw new Error("Conditional update failed");
    console.log(JSON.stringify({ privateRead: true, conditionalWrite: true, storeIdPresent: Boolean(created.url) }));
  } finally {
    await del(pathname, { access: "private" }).catch(() => {});
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
