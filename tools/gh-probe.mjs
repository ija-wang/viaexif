/* tools/gh-probe.mjs — check whether the cloned Edge profile is still signed in
 * to GitHub, and whether the session currently has sudo mode. */
import { cloneProfile, launch } from "./cdp.mjs";
import { rm } from "node:fs/promises";

const SRC = `${process.env.LOCALAPPDATA}/Microsoft/Edge/User Data`;
const HEADLESS = process.env.HEADFUL ? false : true;

const dir = await cloneProfile(SRC);
const b = await launch(dir, { port: 9411, headless: HEADLESS });
try {
  await b.goto("https://github.com/", { settle: 3500 });
  const info = await b.evaluate(`(() => ({
    url: location.href,
    title: document.title,
    login: document.querySelector('meta[name="user-login"]')?.content || null,
    hasSignIn: !!document.querySelector('a[href="/login"]'),
    avatar: document.querySelector('img.avatar')?.src || null,
  }))()`);
  console.log("PROBE", JSON.stringify(info, null, 2));

  await b.goto("https://github.com/settings/ssh/new", { settle: 3000 });
  const sudo = await b.evaluate(`(() => ({
    url: location.href,
    title: document.title,
    needPassword: !!document.querySelector('input[name="password"]'),
    hasKeyForm: !!document.querySelector('input[name="key"]'),
    h1: document.querySelector('h1')?.textContent?.trim() || null,
  }))()`);
  console.log("SSH_NEW", JSON.stringify(sudo, null, 2));
} finally {
  b.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
