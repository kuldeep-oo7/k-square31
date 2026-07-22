const fs = require("node:fs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const mobile = process.argv.includes("--mobile");
  const qaUsername = process.env.K2_QA_USERNAME;
  const qaPassword = process.env.K2_QA_PASSWORD;
  if (!qaUsername || !qaPassword) {
    throw new Error("Set K2_QA_USERNAME and K2_QA_PASSWORD before running browser QA");
  }
  const aiMode = qaUsername === "ai";
  const target = await fetch("http://127.0.0.1:9223/json/new?about%3Ablank", { method: "PUT" }).then((response) => response.json());
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const waiting = new Map();
  let id = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  };
  await new Promise((resolve) => { socket.onopen = resolve; });
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

  await send("Page.enable");
  await send("Runtime.enable");
  if (mobile) {
    await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  await send("Page.navigate", { url: "https://k-square31.vercel.app" });
  await sleep(3500);
  const login = await evaluate(`fetch('/api/auth', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({username:${JSON.stringify(qaUsername)},password:${JSON.stringify(qaPassword)}})
  }).then(async response => ({ok: response.ok, body: await response.json()}))`);
  if (!login.result?.result?.value?.ok) throw new Error(`Browser login failed: ${JSON.stringify(login.result?.result?.value)}`);
  await evaluate(`location.reload()`);

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1000);
    const result = await evaluate(`document.getElementById('authGate').classList.contains('signed-in') && ${aiMode ? "Number(document.getElementById('portfolioBadge').textContent) > 0 && document.querySelectorAll('.ai-stock').length === 130" : "document.querySelectorAll('#focusMap .chunk-row').length === 10"}`);
    if (result.result?.result?.value) { ready = true; break; }
  }
  if (!ready) throw new Error("Signed-in 10-chunk map did not become ready");
  await evaluate(`if (!document.getElementById('dedicationIntro').classList.contains('open')) document.getElementById('replayStoryButton').click()`);
  await sleep(900);
  const storyShot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(mobile ? "k2-story-mobile.png" : "k2-story-preview.png", Buffer.from(storyShot.result.data, "base64"));
  await evaluate(`document.getElementById('storySkip').click()`);
  await sleep(700);
  await evaluate(`window.scrollTo(0,0)`);
  await sleep(700);
  const heroShot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(mobile ? "k2-living-hero-mobile.png" : "k2-living-hero.png", Buffer.from(heroShot.result.data, "base64"));
  if (aiMode) {
    await evaluate(`document.querySelector('[data-tab="portfolio"]').click()`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(500);
      const result = await evaluate(`Boolean(document.querySelector('.ai-command'))`);
      if (result.result?.result?.value) break;
    }
    await evaluate(`document.getElementById('portfolioPanel').scrollIntoView({block:'start'}); window.scrollBy(0,-20)`);
    await sleep(1000);
    const aiShot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(mobile ? "k2-ai-mobile.png" : "k2-ai-desktop.png", Buffer.from(aiShot.result.data, "base64"));
    socket.close();
    return;
  }
  await evaluate(`document.getElementById('focusMap').scrollIntoView({block:'start'}); window.scrollBy(0,-20)`);
  await sleep(1500);
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(mobile ? "k2-focus-mobile.png" : "k2-focus-preview.png", Buffer.from(shot.result.data, "base64"));
  await evaluate(`document.querySelector('[data-tab="portfolio"]').click()`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(300);
    const result = await evaluate(`document.querySelectorAll('.exit-band').length >= 5`);
    if (result.result?.result?.value) break;
  }
  await evaluate(`document.querySelector('.holding-shell').scrollIntoView({block:'start'}); window.scrollBy(0,-20)`);
  await sleep(700);
  const portfolioShot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(mobile ? "k2-portfolio-mobile.png" : "k2-portfolio-quant.png", Buffer.from(portfolioShot.result.data, "base64"));
  await evaluate(`document.querySelector('[data-tab="watchlist"]').click(); document.querySelector('[data-symbol="ICICIGI"]').click()`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(300);
    const result = await evaluate(`document.querySelectorAll('#drawerContent .signal-card').length >= 8`);
    if (result.result?.result?.value) break;
  }
  await sleep(500);
  const drawerShot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(mobile ? "k2-drawer-mobile.png" : "k2-drawer-quant.png", Buffer.from(drawerShot.result.data, "base64"));
  await evaluate(`document.querySelector('.live-ladder-location').scrollIntoView({block:'center'})`);
  await sleep(500);
  const ladderShot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(mobile ? "k2-ladder-location-mobile.png" : "k2-ladder-location.png", Buffer.from(ladderShot.result.data, "base64"));
  socket.close();
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
