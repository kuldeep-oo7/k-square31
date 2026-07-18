const crypto = require("node:crypto");
const { get, put, BlobPreconditionFailedError } = require("@vercel/blob");

function emptyPortfolio() {
  return { version: 1, lots: [], realizedPnl: 0, transactions: [], updatedAt: null };
}

function userPath(username) {
  const id = crypto.createHash("sha256").update(`k2:${username}`).digest("hex").slice(0, 32);
  return `portfolios/${id}.json`;
}

async function streamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readDocument(pathname, fallback) {
  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) return { data: structuredClone(fallback), etag: null };
  const data = JSON.parse(await streamText(result.stream));
  return { data, etag: result.blob.etag };
}

async function writeDocument(pathname, data, etag) {
  return put(pathname, JSON.stringify(data), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: Boolean(etag),
    ifMatch: etag || undefined,
    contentType: "application/json",
    cacheControlMaxAge: 60
  });
}

async function readPortfolio(username) {
  return readDocument(userPath(username), emptyPortfolio());
}

async function mutatePortfolio(username, mutator) {
  const pathname = userPath(username);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readDocument(pathname, emptyPortfolio());
    const next = await mutator(structuredClone(current.data));
    next.version = 1;
    next.updatedAt = new Date().toISOString();
    try {
      await writeDocument(pathname, next, current.etag);
      return next;
    } catch (error) {
      const conflict = error instanceof BlobPreconditionFailedError || error?.status === 409 || error?.statusCode === 409;
      if (!conflict || attempt === 4) throw error;
    }
  }
  throw new Error("Portfolio update conflict");
}

function ratePath(ip) {
  const id = crypto.createHmac("sha256", process.env.BLOB_READ_WRITE_TOKEN || "local").update(ip).digest("hex").slice(0, 40);
  return `security/login-rate/${id}.json`;
}

async function loginRate(ip, failed) {
  const pathname = ratePath(ip);
  const now = Date.now();
  const current = await readDocument(pathname, { windowStarted: now, failures: 0, blockedUntil: 0 });
  let record = current.data;
  if (record.blockedUntil > now) return { allowed: false, retryAfter: Math.ceil((record.blockedUntil - now) / 1000) };
  if (now - record.windowStarted > 15 * 60 * 1000) record = { windowStarted: now, failures: 0, blockedUntil: 0 };
  if (failed === null) return { allowed: true, retryAfter: 0 };
  record.failures = failed ? record.failures + 1 : 0;
  if (!failed) record.windowStarted = now;
  if (record.failures >= 5) record.blockedUntil = now + 15 * 60 * 1000;
  try { await writeDocument(pathname, record, current.etag); } catch { /* Authentication still uses a fixed response delay. */ }
  return { allowed: record.blockedUntil <= now, retryAfter: record.blockedUntil > now ? 900 : 0 };
}

module.exports = { emptyPortfolio, loginRate, mutatePortfolio, readPortfolio };
