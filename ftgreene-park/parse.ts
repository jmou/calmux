import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { parseHTML } from "linkedom";

type Element = ReturnType<typeof parseHTML>["document"]["documentElement"];

function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`missing ${what}`);
  return value;
}

function query(elem: Element, selector: string) {
  return must(elem.querySelector(selector), selector);
}

// We are not a true DOM, so use getAttribute instead of properties like href.
function resolveHref(elem: Element, baseUrl: string) {
  const href = elem.getAttribute("href");
  if (!href) return undefined;
  return new URL(href, baseUrl).href;
}

function parseEvent(elem: Element, baseUrl: string) {
  // The encoded Google Calender URL uses UTC time which we prefer.
  const gCalUrl = must(
    query(elem, "a.eventlist-meta-export-google").getAttribute("href"),
    "Google Calendar href",
  );
  const dates = must(new URL(gCalUrl).searchParams.get("dates"), "dates").split("/");
  return {
    title: query(elem, ".eventlist-title").textContent,
    url: resolveHref(query(elem, "a"), baseUrl),
    imageUrl: query(elem, "a img").getAttribute("src"),
    categories: [...elem.querySelectorAll(".eventlist-cats a")].map((e) => e.textContent),
    startAt: dates[0],
    endAt: dates[1],
    description: query(elem, ".eventlist-excerpt").innerText,
  };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { "base-url": { type: "string" } },
    allowPositionals: true,
  });

  const baseUrl = values["base-url"];
  if (positionals.length != 1 || !baseUrl) {
    console.error("usage: parse.ts --base-url <base-url> <scrape.html>");
    process.exit(1);
  }

  const text = await readFile(positionals[0], "utf-8");
  const { document } = parseHTML(text);
  const events = [...document.querySelectorAll(".eventlist-event--upcoming")]
    .map((elem) => parseEvent(elem, baseUrl));
  console.log(JSON.stringify({ name: document.title, events }, null, 2));
}
