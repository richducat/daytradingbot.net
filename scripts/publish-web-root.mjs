import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps", "web", "dist");
const baseHtml = await readFile(path.join(dist, "index.html"), "utf8");

const routes = [
  {
    path: "app",
    title: "Open your Bluechip dashboard | DayTradingBot",
    description: "Open Bluechip in your browser, connect Robinhood, choose your dollar limits, and start with a no-money Practice run.",
    ogTitle: "Your Bluechip dashboard",
    robots: "noindex, nofollow",
  },
  {
    path: "get-started",
    title: "Build my trading-bot setup | DayTradingBot",
    description: "Answer eight plain-English questions and see a suggested bot, account, mode, and dollar limits before you pay.",
    ogTitle: "See your trading-bot setup before you buy",
    robots: "index, follow, max-image-preview:large",
  },
  {
    path: "welcome",
    title: "Your Bluechip dashboard is ready | DayTradingBot",
    description: "Private delivery of your access code and the link to open Bluechip in your browser.",
    ogTitle: "Your Bluechip dashboard is ready",
    robots: "noindex, nofollow",
  },
  {
    path: "privacy",
    title: "Privacy — DayTradingBot",
    description: "How DayTradingBot handles bot-picker answers, credentials, trading records, and license data.",
    ogTitle: "Privacy — DayTradingBot",
    robots: "index, follow, max-image-preview:large",
  },
  {
    path: "risk-disclosure",
    title: "Risk disclosure — DayTradingBot",
    description: "The plain-language risks of real trading and automated software.",
    ogTitle: "Risk disclosure — DayTradingBot",
    robots: "index, follow, max-image-preview:large",
  },
  {
    path: "terms",
    title: "Founder license terms — DayTradingBot",
    description: "DayTradingBot license terms, browser access, bot choice, risk acknowledgement, Mac use, and refunds.",
    ogTitle: "Founder license terms — DayTradingBot",
    robots: "index, follow, max-image-preview:large",
  },
];

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceMeta(html, attribute, attributeValue, value) {
  const pattern = new RegExp(
    `(<meta\\s+${attribute}="${escapePattern(attributeValue)}"\\s+content=")[^"]*(")`,
  );
  if (!pattern.test(html)) throw new Error(`Missing meta tag: ${attribute}=${attributeValue}`);
  return html.replace(pattern, `$1${value}$2`);
}

function replaceCanonical(html, value) {
  const pattern = /(<link\s+rel="canonical"\s+href=")[^"]*(")/;
  if (!pattern.test(html)) throw new Error("Missing canonical link");
  return html.replace(pattern, `$1${value}$2`);
}

function routeHtml(route) {
  const url = `https://daytradingbot.net/${route.path}/`;
  let html = baseHtml;
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${route.title}</title>`);
  html = replaceMeta(html, "name", "description", route.description);
  html = replaceMeta(html, "name", "robots", route.robots);
  html = replaceCanonical(html, url);
  html = replaceMeta(html, "property", "og:title", route.ogTitle);
  html = replaceMeta(html, "property", "og:description", route.description);
  html = replaceMeta(html, "property", "og:url", url);
  return html;
}

await cp(path.join(dist, "assets"), path.join(root, "assets"), { recursive: true });
await cp(path.join(dist, "images"), path.join(root, "images"), { recursive: true });
await writeFile(path.join(root, "index.html"), baseHtml, "utf8");

for (const route of routes) {
  const routeDirectory = path.join(root, route.path);
  await mkdir(routeDirectory, { recursive: true });
  await writeFile(path.join(routeDirectory, "index.html"), routeHtml(route), "utf8");
}

const notFoundHtml = replaceMeta(baseHtml, "name", "robots", "noindex, nofollow");
await writeFile(path.join(root, "404.html"), notFoundHtml, "utf8");

process.stdout.write(`Published DayTradingBot web build to ${root}\n`);
