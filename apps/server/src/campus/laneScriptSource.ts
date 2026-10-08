/**
 * Source of the fork's own lane script. It is written next to the lane's data
 * at run time and executed with the lane's Node from the harness directory, so
 * it can import the harness library and drive the same headless Chrome broker
 * the reads use. Commands:
 *
 * - `login <deakin|microsoft>` signs the Deakin account in the way the
 *   person's own auth robot does: password and software OATH seed from the
 *   macOS Keychain, the code computed locally, nothing shown on screen.
 * - `inbox <top>` lists the Outlook inbox from the row structure of the
 *   current Outlook web app, which the harness's older parser no longer reads.
 * - `mail <conversationId>` opens one conversation and reads its messages.
 * - `ontrack-token` mints an OnTrack API token from the signed-in session,
 *   signing in first when the session has lapsed.
 *
 * Every command prints one JSON line on stdout and exits non-zero on failure.
 */
export const LANE_SCRIPT_SOURCE = String.raw`
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const HARNESS = process.env.T3_LANE_HARNESS_DIR;
const [command = "login", argument = ""] = process.argv.slice(2);
const account = process.env.MICROSOFT_KEYCHAIN_ACCOUNT || "";
const PASSWORD_SERVICE =
  process.env.T3_LANE_PASSWORD_SERVICE || "codex-deakin-ontrack-microsoft-password";
const TOTP_SERVICES = (
  process.env.T3_LANE_TOTP_SERVICES ||
  "com.romil.sara-deakin-auth-robot.totp:ACCOUNT,codex-deakin-microsoft-totp:codex"
).split(",");
const TIMEOUT_MS = Number(process.env.T3_LANE_LOGIN_TIMEOUT_MS || 180_000);
const STEP_MS = 700;

const emit = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const fail = (reason, detail) => {
  emit({ ok: false, reason, detail });
  process.exit(1);
};

function keychain(service, acct) {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", service, "-a", acct],
      (error, stdout) => resolve(error ? null : String(stdout).replace(/\n$/, "")),
    );
  });
}

function decodeBase32(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const totpWindow = (now = Date.now()) => Math.floor(now / 1000 / 30);

function totpCode(seed, now = Date.now()) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(totpWindow(now)));
  const digest = crypto.createHmac("sha1", decodeBase32(seed)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function visibleText(page) {
  return page
    .evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim())
    .catch(() => "");
}

async function clickFirst(page, locators) {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 4_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function fillAccount(page) {
  const input = page
    .locator('input[type="email"], input[name="loginfmt"], input[autocomplete="username"]')
    .first();
  if (!(await input.isVisible().catch(() => false))) return false;
  await input.fill(account);
  return clickFirst(page, [
    page.getByRole("button", { name: /^(sign in|next|continue)$/i }).first(),
    page.locator('input[type="submit"]').first(),
  ]);
}

async function choosePasswordMethod(page) {
  const text = await visibleText(page);
  if (!/choose a way to sign in|choose how to sign in|other ways to sign in/i.test(text)) {
    return false;
  }
  const label = /^(use my password|use your password instead)$/i;
  return clickFirst(page, [
    page.getByRole("button", { name: label }).first(),
    page.getByRole("option", { name: label }).first(),
    page.getByText(label).first(),
  ]);
}

async function fillPassword(page, password) {
  const input = page
    .locator('input[type="password"], input[name="passwd"], input[autocomplete="current-password"]')
    .first();
  if (!(await input.isVisible().catch(() => false))) return false;
  await input.fill(password);
  return clickFirst(page, [
    page.getByRole("button", { name: /^(sign in|next|continue)$/i }).first(),
    page.locator('input[type="submit"]').first(),
  ]);
}

const CODE_INPUT =
  '#idTxtBx_SAOTCC_OTC, #idTxtBx_OTC_Password, input[name="otc"], input[name="code"], input[autocomplete="one-time-code"]';

async function routeToSoftwareCode(page) {
  const text = await visibleText(page);
  if (!/security code|verification code|one.?time code|another way|different way|can.?t use.*app|approve.*request|authenticator/i.test(text)) {
    return false;
  }
  if (await page.locator(CODE_INPUT).first().isVisible().catch(() => false)) return false;
  return clickFirst(page, [
    page.locator('[data-value="PhoneAppOTP"]').first(),
    page.getByText(/enter a security code from your microsoft account or authenticator app instead/i).first(),
    page.getByText(/use a verification code/i).first(),
    page.getByText(/use a code/i).first(),
    page.getByText(/i can.?t use my (outlook|microsoft authenticator).*app right now/i).first(),
    page.getByText(/get a code a different way/i).first(),
    page.getByText(/sign in another way/i).first(),
    page.getByText(/other ways to sign in/i).first(),
    page.getByText(/use another method/i).first(),
    page.getByText(/sign.?in options/i).first(),
  ]);
}

async function leavePasskeyBridge(page) {
  const where = page.url() + " " + (await page.title().catch(() => ""));
  if (!/\/(?:bridge\/fido|fido\/get)(?:\?|$)|face, fingerprint, pin or security key/i.test(where)) {
    return false;
  }
  await sleep(1_500);
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
  return clickFirst(page, [
    page.getByText(/sign in another way/i).first(),
    page.getByText(/other ways to sign in/i).first(),
    page.getByText(/use a different verification option/i).first(),
  ]);
}

async function acceptStaySignedIn(page) {
  const text = await visibleText(page);
  if (!/stay signed in\??/i.test(text)) return false;
  return clickFirst(page, [
    page.locator("#idSIButton9").first(),
    page.getByRole("button", { name: /^yes$/i }).first(),
  ]);
}

function providerProblem(text) {
  if (/incorrect verification code|didn.?t enter the expected verification code|invalid verification code/i.test(text)) {
    return "The verification code was refused; the OATH seed in the Keychain may no longer match.";
  }
  if (/your account or password is incorrect|password is incorrect|that password is incorrect/i.test(text)) {
    return "Microsoft refused the password saved in the Keychain.";
  }
  if (/we couldn.?t sign you in|sorry, but we.?re having trouble|this is not the right page/i.test(text)) {
    return "Microsoft could not complete the sign-in.";
  }
  if (/account has been locked|too many attempts/i.test(text)) {
    return "Microsoft has locked sign-in attempts for now.";
  }
  return null;
}

/**
 * Pushes the login page forward one step at a time until the portal says it
 * is signed in. A TOTP is submitted at most once per 30-second window.
 */
async function drive(page, isSignedIn, { password, seed, kickOff }) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastCodeWindow = null;
  while (Date.now() < deadline) {
    if (await isSignedIn().catch(() => false)) return { ok: true };
    const text = await visibleText(page);
    const problem = providerProblem(text);
    if (problem) return { ok: false, reason: "provider", detail: problem };
    if (kickOff && (await kickOff().catch(() => false))) {
      await sleep(STEP_MS);
      continue;
    }
    const codeInput = page.locator(CODE_INPUT).first();
    if (await codeInput.isVisible().catch(() => false)) {
      const window = totpWindow();
      if (lastCodeWindow === window) {
        await sleep(1_000);
        continue;
      }
      lastCodeWindow = window;
      await codeInput.fill(totpCode(seed));
      await clickFirst(page, [
        page.getByRole("button", { name: /^(verify|next|continue|sign in)$/i }).first(),
        page.locator('input[type="submit"]').first(),
      ]);
      await sleep(STEP_MS);
      continue;
    }
    if (
      (await acceptStaySignedIn(page)) ||
      (await leavePasskeyBridge(page)) ||
      (await fillAccount(page)) ||
      (await choosePasswordMethod(page)) ||
      (await fillPassword(page, password)) ||
      (await routeToSoftwareCode(page))
    ) {
      await sleep(STEP_MS);
      continue;
    }
    await sleep(STEP_MS);
  }
  return { ok: false, reason: "timeout", detail: "The sign-in did not finish in time." };
}

async function readCredentials() {
  if (!account) fail("credentials_missing", "No account is configured for the lane.");
  const password = await keychain(PASSWORD_SERVICE, account);
  if (!password) {
    fail("credentials_missing", "No Deakin password for the lane account is in the Keychain.");
  }
  let seed = null;
  for (const entry of TOTP_SERVICES) {
    const [service, acct] = entry.split(":");
    seed = await keychain(service, acct === "ACCOUNT" ? account : acct);
    if (seed) break;
  }
  if (!seed) fail("credentials_missing", "No software OATH seed for the account is in the Keychain.");
  return { password, seed };
}

const pageOf = async (session) =>
  session.page ?? session.context.pages()[0] ?? (await session.context.newPage());

async function microsoftLogin(credentials) {
  const lib = await import(pathToFileURL(HARNESS + "/scripts/lib/microsoft.js").href);
  const session = await lib.launchMicrosoftContext({ headless: true });
  const page = await pageOf(session);
  try {
    for (const key of ["mail", "calendar", "teams"]) {
      await page
        .goto(lib.MICROSOFT_SERVICES[key].homeUrl, { waitUntil: "domcontentloaded" })
        .catch(() => {});
      const result = await drive(page, () => lib.isMicrosoftServiceAuthenticated(page, key), {
        ...credentials,
      });
      if (!result.ok) fail(result.reason, lib.MICROSOFT_SERVICES[key].label + ": " + result.detail);
    }
    emit({ ok: true });
  } finally {
    await lib.closeMicrosoftContext(session).catch(() => {});
  }
}

async function deakinLogin(credentials) {
  const ontrack = await import(pathToFileURL(HARNESS + "/scripts/lib/ontrack.js").href);
  const portals = await import(pathToFileURL(HARNESS + "/scripts/lib/portals.js").href);
  const session = await ontrack.launchContext({ headless: true, useSavedState: true });
  const page = await pageOf(session);
  try {
    await page.goto(ontrack.SIGN_IN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    const onTrackResult = await drive(page, () => ontrack.isAuthenticated(page), {
      ...credentials,
      kickOff: () => ontrack.kickOffLoginIfNeeded(page),
    });
    if (!onTrackResult.ok) fail(onTrackResult.reason, "OnTrack: " + onTrackResult.detail);
    await page
      .goto(portals.PORTAL_CONFIGS.deakinsync.homeUrl, { waitUntil: "domcontentloaded" })
      .catch(() => {});
    const syncResult = await drive(page, () => portals.isPortalAuthenticated(page, "deakinsync"), {
      ...credentials,
    });
    if (!syncResult.ok) fail(syncResult.reason, "DeakinSync: " + syncResult.detail);
    await ontrack.saveAuthState(session.context).catch(() => {});
    emit({ ok: true });
  } finally {
    await ontrack.closeAll(session).catch(() => {});
  }
}

/** An OnTrack API token from the signed-in session, signing in first if it lapsed. */
async function ontrackToken() {
  const ontrack = await import(pathToFileURL(HARNESS + "/scripts/lib/ontrack.js").href);
  const session = await ontrack.launchContext({ headless: true, useSavedState: true });
  const page = await pageOf(session);
  try {
    await page.goto(ontrack.HOME_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    const settled = Date.now() + 15_000;
    while (Date.now() < settled && !(await ontrack.isAuthenticated(page).catch(() => false))) {
      await sleep(STEP_MS);
    }
    if (!(await ontrack.isAuthenticated(page).catch(() => false))) {
      const credentials = await readCredentials();
      await page.goto(ontrack.SIGN_IN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      const result = await drive(page, () => ontrack.isAuthenticated(page), {
        ...credentials,
        kickOff: () => ontrack.kickOffLoginIfNeeded(page),
      });
      if (!result.ok) {
        fail(result.reason === "timeout" ? "sign_in_required" : result.reason, "OnTrack: " + result.detail);
      }
      await ontrack.saveAuthState(session.context).catch(() => {});
    }
    const auth = await ontrack.getApiAuth(page);
    emit({ ok: true, authToken: auth.authToken, username: auth.user?.username ?? account });
  } finally {
    await ontrack.closeAll(session).catch(() => {});
  }
}

/** The signed-in Outlook mail page, or a sign-in failure the pages understand. */
async function openMail(lib, page) {
  await page.goto(lib.MICROSOFT_SERVICES.mail.homeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await lib.isMicrosoftServiceAuthenticated(page, "mail").catch(() => false)) return true;
    await sleep(600);
  }
  return false;
}

const ROW_SELECTOR = '[role="option"][data-convid]';

/** Reads the rows of the Outlook message list as the current web app lays them out. */
function readRowsInPage(top) {
  const junk = /[͏​-‏⁠﻿-]/g;
  const clean = (value) => (value || "").replace(junk, "").replace(/\s+/g, " ").trim();
  return Array.from(document.querySelectorAll('[role="option"][data-convid]'))
    .slice(0, top)
    .map((row) => {
      const leaves = Array.from(row.querySelectorAll("span, div")).filter(
        (node) => node.children.length === 0 && clean(node.textContent),
      );
      const senderNode = leaves.find((node) => /@/.test(node.getAttribute("title") || ""));
      const timeNode = leaves.find((node) =>
        /\d{1,2}:\d{2}\s?(AM|PM)|\d{2}\/\d{2}\/\d{4}/i.test(node.getAttribute("title") || ""),
      );
      const senderIndex = senderNode ? leaves.indexOf(senderNode) : -1;
      const timeIndex = timeNode ? leaves.indexOf(timeNode) : -1;
      const between = senderIndex >= 0 && timeIndex > senderIndex ? leaves.slice(senderIndex + 1, timeIndex) : [];
      const after = timeIndex >= 0 ? leaves.slice(timeIndex + 1) : [];
      const aria = clean(row.getAttribute("aria-label"));
      return {
        ref: row.getAttribute("data-convid"),
        sender: senderNode ? clean(senderNode.textContent) : null,
        senderAddress: senderNode ? clean(senderNode.getAttribute("title")) : null,
        subject: between.length > 0 ? clean(between.map((node) => node.textContent).join(" ")) : null,
        receivedAt: timeNode ? clean(timeNode.getAttribute("title")) : null,
        preview: after.length > 0 ? clean(after.map((node) => node.textContent).join(" ")).slice(0, 220) : null,
        unread: /^unread\b/i.test(aria) || /\bunread\b/i.test(aria.slice(0, 40)),
        hasAttachments: /attachment/i.test(aria),
      };
    });
}

async function inbox(top) {
  const lib = await import(pathToFileURL(HARNESS + "/scripts/lib/microsoft.js").href);
  const session = await lib.launchMicrosoftContext({ headless: true });
  const page = await pageOf(session);
  try {
    if (!(await openMail(lib, page))) {
      fail("sign_in_required", "No valid Outlook Mail session found; sign in first.");
    }
    await page.waitForSelector(ROW_SELECTOR, { timeout: 20_000 }).catch(() => {});
    await sleep(1_500);
    const messages = await page.evaluate(readRowsInPage, Math.max(1, Math.min(50, top)));
    emit({ ok: true, messages });
  } finally {
    await lib.closeMicrosoftContext(session).catch(() => {});
  }
}

/** Opens one conversation by its id and reads the messages shown in the reading pane. */
async function mail(conversationId) {
  const lib = await import(pathToFileURL(HARNESS + "/scripts/lib/microsoft.js").href);
  const session = await lib.launchMicrosoftContext({ headless: true });
  const page = await pageOf(session);
  try {
    if (!(await openMail(lib, page))) {
      fail("sign_in_required", "No valid Outlook Mail session found; sign in first.");
    }
    await page.waitForSelector(ROW_SELECTOR, { timeout: 20_000 }).catch(() => {});
    const row = page.locator('[role="option"][data-convid="' + conversationId.replace(/"/g, '\\"') + '"]').first();
    if (!(await row.isVisible().catch(() => false))) {
      fail("not_found", "That conversation is not in the visible inbox any more.");
    }
    await row.click({ timeout: 5_000 });
    await sleep(2_500);
    const messages = await page.evaluate(() => {
      const junk = /[͏​-‏⁠﻿-]/g;
      const clean = (value) => (value || "").replace(junk, "").replace(/\s+/g, " ").trim();
      const pane =
        document.querySelector('[role="main"] [role="region"][aria-label]') ??
        document.querySelector('[aria-label="Reading Pane"]') ??
        document.querySelector('[role="main"]');
      const bodies = Array.from((pane ?? document).querySelectorAll('[aria-label="Message body"], [role="document"]'));
      const items = bodies.map((body) => {
        const card = body.closest('[role="listitem"], [data-convid], [role="group"], article') ?? body.parentElement;
        const sender = card?.querySelector("span[title*='@']");
        const time = Array.from(card?.querySelectorAll("span[title]") ?? []).find((node) =>
          /\d{1,2}:\d{2}\s?(AM|PM)|\d{2}\/\d{2}\/\d{4}/i.test(node.getAttribute("title") || ""),
        );
        return {
          sender: sender ? clean(sender.textContent) : null,
          senderAddress: sender ? clean(sender.getAttribute("title")) : null,
          receivedAt: time ? clean(time.getAttribute("title")) : null,
          body: clean(body.innerText).slice(0, 12_000),
        };
      });
      const subjectNode = (pane ?? document).querySelector("h1, h2, [role='heading']");
      return { subject: subjectNode ? clean(subjectNode.textContent) : null, items };
    });
    emit({ ok: true, ...messages });
  } finally {
    await lib.closeMicrosoftContext(session).catch(() => {});
  }
}

if (!HARNESS) fail("configuration", "T3_LANE_HARNESS_DIR is not set.");
if (command === "login") {
  const credentials = await readCredentials();
  if (argument === "deakin") await deakinLogin(credentials);
  else await microsoftLogin(credentials);
} else if (command === "ontrack-token") {
  await ontrackToken();
} else if (command === "inbox") {
  await inbox(Number(argument) || 20);
} else if (command === "mail") {
  if (!argument) fail("invalid_input", "A conversation id is required.");
  await mail(argument);
} else {
  fail("invalid_input", "Unknown lane command.");
}
process.exit(0);
`;
