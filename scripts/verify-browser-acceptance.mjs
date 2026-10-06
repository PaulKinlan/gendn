// scripts/verify-browser-acceptance.mjs — drives headless Chrome to verify speculation rules prefetch.
//
// ACCEPTANCE CRITERIA:
// 1. At 360px mobile emulation, DevTools > Application > Speculation Rules shows NO prefetch requests without user intent.
// 2. The prefetch DOES fire when hovering/pointing at a sibling link.
// 3. Zero console errors.
// 4. Screenshots and extracted CDP logs for both (1) and (2).

import { launch } from "./lib/cdp.mjs";

const OUT_DIR = "reports/speculation-rules";
await Deno.mkdir(OUT_DIR, { recursive: true });

// Boot server on ephemeral port
const serverProc = new Deno.Command("deno", {
  args: ["run", "--allow-net", "--allow-read", "--allow-env", "server.ts"],
  env: { ...Deno.env.toObject(), PORT: "0" },
  stdout: "piped",
  stderr: "inherit",
}).spawn();

let port = 0;
const reader = serverProc.stdout.getReader();
const decoder = new TextDecoder();
let buf = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value);
  const match = /Listening on http:\/\/localhost:(\d+)/.exec(buf);
  if (match) {
    port = Number(match[1]);
    break;
  }
}
reader.releaseLock();
console.log(`[acceptance] server booted on port ${port}`);

const cdpLog = {
  mobileEmulation: {
    ruleSetEvents: [],
    preIntentPrefetches: [],
    postIntentPrefetches: [],
    networkRequests: [],
    consoleErrors: [],
  },
  desktop: {
    ruleSetEvents: [],
    preIntentPrefetches: [],
    postIntentPrefetches: [],
    networkRequests: [],
    consoleErrors: [],
  },
};

let exitCode = 0;
const browser = await launch();

try {
  // ==========================================
  // PHASE 1: 360px MOBILE EMULATION
  // ==========================================
  console.log("\n=== Phase 1: 360px Mobile Emulation ===");
  const mobilePage = await browser.newPage({
    width: 360,
    height: 740,
    mobile: true,
    deviceScaleFactor: 3,
  });

  const mobilePrefetchRequests = [];
  mobilePage.conn.on((msg) => {
    if (msg.sessionId !== mobilePage.sessionId) return;
    if (msg.method === "Preload.ruleSetUpdated") {
      cdpLog.mobileEmulation.ruleSetEvents.push(msg.params);
    }
    if (msg.method === "Preload.prefetchStatusUpdated") {
      mobilePrefetchRequests.push(msg.params);
    }
    if (msg.method === "Network.requestWillBeSent") {
      const sp = msg.params.request?.headers?.["sec-purpose"] ??
        msg.params.request?.headers?.["Sec-Purpose"];
      if (sp === "prefetch") {
        cdpLog.mobileEmulation.networkRequests.push({
          url: msg.params.request.url,
          headers: msg.params.request.headers,
        });
      }
    }
  });

  await mobilePage.sendSession("Preload.enable");
  await mobilePage.goto(`http://127.0.0.1:${port}/v147/`);
  await new Promise((r) => setTimeout(r, 600));

  // Check 1: Speculation rules rule set is registered
  if (cdpLog.mobileEmulation.ruleSetEvents.length === 0) {
    console.error("FAIL: No Preload.ruleSetUpdated event received");
    exitCode = 1;
  } else {
    console.log(
      "PASS: Speculation rules ruleSet registered:",
      cdpLog.mobileEmulation.ruleSetEvents[0].ruleSet?.sourceText,
    );
  }

  // Check 2: NO prefetch requests without user intent
  cdpLog.mobileEmulation.preIntentPrefetches = [...mobilePrefetchRequests];
  if (mobilePrefetchRequests.length > 0 || cdpLog.mobileEmulation.networkRequests.length > 0) {
    console.error(
      `FAIL: Prefetches fired without intent: ${mobilePrefetchRequests.length} preload, ${cdpLog.mobileEmulation.networkRequests.length} network`,
    );
    exitCode = 1;
  } else {
    console.log("PASS: 0 prefetch requests without user intent at 360px mobile emulation");
  }

  // Capture Screenshot 1: Mobile Initial (No Intent)
  const initialShotPath = `${OUT_DIR}/mobile-initial-no-intent.png`;
  await mobilePage.screenshot(initialShotPath);
  console.log(`Saved screenshot 1: ${initialShotPath}`);

  // Find a sibling link in DOM
  const link = await mobilePage.evaluate(`(() => {
    const anchors = Array.from(document.querySelectorAll("a"));
    const match = anchors.find(a => a.pathname.startsWith("/v147/") && a.pathname !== "/v147/");
    if (!match) return null;
    match.scrollIntoView({ block: "center" });
    const r = match.getBoundingClientRect();
    return {
      href: match.getAttribute("href"),
      pathname: match.pathname,
      text: match.innerText.trim(),
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
  })()`);

  if (!link) {
    console.error("FAIL: Could not locate sibling link matching /v147/*");
    exitCode = 1;
  } else {
    console.log(`Located sibling link: ${link.href} ("${link.text}") at (${link.x}, ${link.y})`);

    // Hover / point at the link (user intent)
    console.log("Dispatching mouseMoved over link (user intent simulation)...");
    await mobilePage.sendSession("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: link.x,
      y: link.y,
    });
    // Give prefetch time to initiate and complete
    await new Promise((r) => setTimeout(r, 1200));

    // Check 3: Prefetch fired on hover
    cdpLog.mobileEmulation.postIntentPrefetches = [...mobilePrefetchRequests];
    const matchingPrefetch = mobilePrefetchRequests.find((p) =>
      p.prefetchUrl?.includes(link.pathname) || p.key?.url?.includes(link.pathname)
    );
    const matchingNet = cdpLog.mobileEmulation.networkRequests.find((r) =>
      r.url.includes(link.pathname)
    );

    if (matchingPrefetch || matchingNet) {
      console.log(
        `PASS: Prefetch fired for ${link.pathname} on user intent! Status: ${
          matchingPrefetch?.status ?? "Sent"
        }`,
      );
    } else {
      console.error(`FAIL: No prefetch triggered for ${link.pathname} after hover`);
      exitCode = 1;
    }

    // Capture Screenshot 2: Mobile Post-Hover
    const hoverShotPath = `${OUT_DIR}/mobile-hover-intent.png`;
    await mobilePage.screenshot(hoverShotPath);
    console.log(`Saved screenshot 2: ${hoverShotPath}`);
  }

  // Check 4: Zero console errors
  const mobileErrors = mobilePage.diagnostics().consoleErrors;
  cdpLog.mobileEmulation.consoleErrors = mobileErrors;
  if (mobileErrors.length > 0) {
    console.error("FAIL: Mobile console errors detected:", mobileErrors);
    exitCode = 1;
  } else {
    console.log("PASS: Zero console errors at 360px mobile emulation");
  }

  await mobilePage.close();

  // ==========================================
  // PHASE 2: DESKTOP VIEWPORT (1280x800)
  // ==========================================
  console.log("\n=== Phase 2: Desktop Viewport (1280x800) ===");
  const desktopPage = await browser.newPage({
    width: 1280,
    height: 800,
    mobile: false,
    deviceScaleFactor: 1,
  });

  const desktopPrefetchRequests = [];
  desktopPage.conn.on((msg) => {
    if (msg.sessionId !== desktopPage.sessionId) return;
    if (msg.method === "Preload.ruleSetUpdated") {
      cdpLog.desktop.ruleSetEvents.push(msg.params);
    }
    if (msg.method === "Preload.prefetchStatusUpdated") {
      desktopPrefetchRequests.push(msg.params);
    }
    if (msg.method === "Network.requestWillBeSent") {
      const sp = msg.params.request?.headers?.["sec-purpose"] ??
        msg.params.request?.headers?.["Sec-Purpose"];
      if (sp === "prefetch") {
        cdpLog.desktop.networkRequests.push({
          url: msg.params.request.url,
          headers: msg.params.request.headers,
        });
      }
    }
  });

  await desktopPage.sendSession("Preload.enable");
  await desktopPage.goto(`http://127.0.0.1:${port}/features`);
  await new Promise((r) => setTimeout(r, 600));

  // Initial: 0 prefetches before hover
  cdpLog.desktop.preIntentPrefetches = [...desktopPrefetchRequests];
  if (desktopPrefetchRequests.length > 0) {
    console.error("FAIL: Desktop prefetch fired without intent");
    exitCode = 1;
  } else {
    console.log("PASS: 0 prefetch requests without user intent on /features");
  }

  // Capture Screenshot 3: Desktop Initial (No Intent)
  const deskInitialShot = `${OUT_DIR}/desktop-initial-no-intent.png`;
  await desktopPage.screenshot(deskInitialShot);
  console.log(`Saved screenshot 3: ${deskInitialShot}`);

  // Hover over a /v* reference link on /features
  const featLink = await desktopPage.evaluate(`(() => {
    const match = Array.from(document.querySelectorAll("a")).find(a => a.pathname.startsWith("/v") && a.pathname !== "/features");
    if (!match) return null;
    match.scrollIntoView({ block: "center" });
    const r = match.getBoundingClientRect();
    return {
      href: match.getAttribute("href"),
      pathname: match.pathname,
      text: match.innerText.trim(),
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
  })()`);

  if (featLink) {
    console.log(`Located feature reference link: ${featLink.href} at (${featLink.x}, ${featLink.y})`);
    await desktopPage.sendSession("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: featLink.x,
      y: featLink.y,
    });
    await new Promise((r) => setTimeout(r, 1200));

    cdpLog.desktop.postIntentPrefetches = [...desktopPrefetchRequests];
    const matched = desktopPrefetchRequests.find((p) =>
      p.prefetchUrl?.includes(featLink.pathname) || p.key?.url?.includes(featLink.pathname)
    );
    if (matched || cdpLog.desktop.networkRequests.length > 0) {
      console.log(`PASS: Prefetch fired for ${featLink.pathname} on desktop hover`);
    } else {
      console.error(`FAIL: Desktop prefetch did not fire for ${featLink.pathname}`);
      exitCode = 1;
    }

    // Capture Screenshot 4: Desktop Post-Hover
    const deskHoverShot = `${OUT_DIR}/desktop-hover-intent.png`;
    await desktopPage.screenshot(deskHoverShot);
    console.log(`Saved screenshot 4: ${deskHoverShot}`);
  }

  const desktopErrors = desktopPage.diagnostics().consoleErrors;
  cdpLog.desktop.consoleErrors = desktopErrors;
  if (desktopErrors.length > 0) {
    console.error("FAIL: Desktop console errors:", desktopErrors);
    exitCode = 1;
  } else {
    console.log("PASS: Zero console errors on desktop");
  }

  await desktopPage.close();
} finally {
  await browser.close();
  try {
    serverProc.kill("SIGKILL");
  } catch {}
}

// Write extracted CDP dump to file
const dumpPath = `${OUT_DIR}/speculation-rules-cdp-dump.json`;
await Deno.writeTextFile(dumpPath, JSON.stringify(cdpLog, null, 2));
console.log(`\nSaved extracted CDP dump: ${dumpPath}`);

if (exitCode !== 0) {
  console.error("\nAcceptance tests FAILED");
  Deno.exit(exitCode);
} else {
  console.log("\nALL ACCEPTANCE CRITERIA PASSED in real Chrome browser!");
}
