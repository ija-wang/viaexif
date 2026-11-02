/* =============================================================================
 * tools/cdp.mjs — tiny Chrome DevTools Protocol helper.
 *
 * Boots a Chromium browser against *a copy* of the user's real profile so the
 * session (GitHub login etc.) carries over, without touching the live profile
 * that the running browser has locked.
 * ========================================================================== */
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BROWSER =
  process.env.BROWSER ||
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

/* Copy the bits of an Edge/Chrome profile that carry cookies + preferences.
 * Local State holds the DPAPI-wrapped key that encrypts the cookie DB, so it
 * must travel with Default/Network/Cookies or every cookie decrypts to junk. */
export async function cloneProfile(srcDir, { keep = [] } = {}) {
  const dst = await mkdtemp(path.join(tmpdir(), "vx-prof-"));
  await cp(path.join(srcDir, "Local State"), path.join(dst, "Local State"), {
    preserveTimestamps: true,
  }).catch(() => {});

  const defDst = path.join(dst, "Default");
  await mkdir(defDst, { recursive: true });

  const wanted = [
    "Preferences",
    "Secure Preferences",
    "Network/Cookies",
    "Network/Cookies-journal",
    ...keep,
  ];
  for (const rel of wanted) {
    const to = path.join(defDst, rel);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(path.join(srcDir, "Default", rel), to, {
      preserveTimestamps: true,
    }).catch(() => {});
  }
  return dst;
}

export async function launch(profileDir, { port = 9411, headless = false } = {}) {
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=msEdgeFirstRunExperience",
    "--disable-sync",
    "--hide-scrollbars",
    "--window-size=1440,960",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new", "--disable-gpu");

  const proc = spawn(BROWSER, args, { stdio: "ignore" });

  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const page = (await res.json()).find((t) => t.type === "page");
      wsUrl = page?.webSocketDebuggerUrl;
    } catch {
      /* still booting */
    }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error("CDP endpoint not ready");

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };

  const send = (method, params = {}) => {
    msgId += 1;
    const id = msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await send("Runtime.enable");
  await send("Page.enable");

  const sleep_ = sleep;

  async function goto(url, { settle = 1200 } = {}) {
    await send("Page.navigate", { url });
    await sleep_(settle);
  }

  async function evaluate(expression, { awaitPromise = true } = {}) {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ||
          r.exceptionDetails.text ||
          "eval failed",
      );
    }
    return r.result?.value;
  }

  function close() {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }

  return { send, goto, evaluate, close, port, sleep: sleep_ };
}

export { sleep, rm };
