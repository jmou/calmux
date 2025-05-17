import { DOMParser, Element } from "jsr:@b-fuze/deno-dom";
import { parseArgs } from "jsr:@std/cli/parse-args";

// We are not a true DOM, so use getAttribute instead of properties like href.
// See https://github.com/b-fuze/deno-dom/issues/72
function resolveHref(elem: Element, baseUrl: string) {
  const href = elem.getAttribute("href");
  if (!href) return undefined;
  return new URL(href, baseUrl).href;
}

function parseEvent(elem: Element, baseUrl: string) {
  // The encoded Google Calender URL uses UTC time which we prefer.
  const gCalUrl = elem.querySelector("a.eventlist-meta-export-google")
    .getAttribute("href");
  const dates = new URL(gCalUrl).searchParams.get("dates").split("/");
  return {
    title: elem.querySelector(".eventlist-title").textContent,
    url: resolveHref(elem.querySelector("a"), baseUrl),
    imageUrl: elem.querySelector("a img").getAttribute("src"),
    categories: [...elem.querySelectorAll(".eventlist-cats a")].map((e) =>
      e.textContent
    ),
    startAt: dates[0],
    endAt: dates[1],
    description: elem.querySelector(".eventlist-excerpt").innerText,
  };
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    string: ["base-url"],
  });

  if (flags._.length != 1 || !flags["base-url"]) {
    console.error("usage: parse.ts --base-url <base-url> <scrape.html>");
    Deno.exit(1);
  }

  const text = await Deno.readTextFile("cal.html");
  const document = new DOMParser().parseFromString(text, "text/html");
  const data = { name: document.title, events: [] };
  for (const elem of document.querySelectorAll(".eventlist-event--upcoming")) {
    data.events.push(parseEvent(elem, flags["base-url"]));
  }
  console.log(JSON.stringify(data, null, 2));
}
