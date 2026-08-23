import { join } from "@std/path";

import { CalendarRenderer, escapeHtml, type EventData } from "./main.ts";

const CALENDAR_NAME = "Calendar";
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

export class ValidationError extends Error {}

function getTrimmed(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function parseDate(raw: string, field: string): Temporal.PlainDate {
  try {
    return Temporal.PlainDate.from(raw);
  } catch {
    throw new ValidationError(`${field} is invalid.`);
  }
}

function parseTimeOnDate(
  date: Temporal.PlainDate,
  raw: string,
  field: string,
): Temporal.Instant {
  try {
    return date.toPlainDateTime(Temporal.PlainTime.from(raw))
      .toZonedDateTime(Temporal.Now.timeZoneId())
      .toInstant();
  } catch {
    throw new ValidationError(`${field} is invalid.`);
  }
}

// The form is one date plus two optional times: leaving both times blank is how
// you get an all-day event, which is a bare date whose endAt is exclusive.
function parseRange(form: FormData): { startAt: string; endAt: string } {
  const date = parseDate(getTrimmed(form, "date"), "Date");
  const startTime = getTrimmed(form, "startTime");
  const endTime = getTrimmed(form, "endTime");

  if (!startTime && !endTime) {
    return { startAt: date.toString(), endAt: date.add({ days: 1 }).toString() };
  }
  if (!startTime || !endTime) {
    throw new ValidationError("Give both a start and end time, or neither.");
  }

  const start = parseTimeOnDate(date, startTime, "Start time");
  const end = parseTimeOnDate(date, endTime, "End time");
  if (Temporal.Instant.compare(end, start) < 0) {
    throw new ValidationError("End time must not be before start time.");
  }
  return { startAt: start.toString(), endAt: end.toString() };
}

function parseOptionalUrl(form: FormData, key: string, label: string): string | undefined {
  const raw = getTrimmed(form, key);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`${label} is not a valid URL.`);
  }
  // renderEvent() puts url straight into an href; javascript: would be XSS.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(`${label} must be an http or https URL.`);
  }
  return raw;
}

function parseCategories(form: FormData): string[] | undefined {
  const raw = getTrimmed(form, "categories");
  if (!raw) return undefined;
  const categories = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return categories.length > 0 ? categories : undefined;
}

export function formDataToEvent(form: FormData): EventData {
  const title = getTrimmed(form, "title");
  if (!title) throw new ValidationError("Title is required.");
  if (title.length > MAX_TITLE_LENGTH) throw new ValidationError("Title is too long.");

  const { startAt, endAt } = parseRange(form);
  // Structurally guaranteed by parseRange(); assert it anyway.
  if (startAt.includes("T") !== endAt.includes("T")) {
    throw new Error("Date/DateTime mismatch");
  }

  const event: EventData = { title, startAt, endAt };

  const description = getTrimmed(form, "description");
  if (description) {
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new ValidationError("Description is too long.");
    }
    event.description = description;
  }

  const url = parseOptionalUrl(form, "url", "Web page");
  if (url) event.url = url;
  const imageUrl = parseOptionalUrl(form, "imageUrl", "Image link");
  if (imageUrl) event.imageUrl = imageUrl;

  const categories = parseCategories(form);
  if (categories) event.categories = categories;

  return event;
}

// --- Event store, one JSON file per submission ------------------------------

export async function loadEvents(dir: string): Promise<EventData[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".json")) names.push(entry.name);
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  names.sort(); // filenames start with startAt, so this is chronological

  const events: EventData[] = [];
  for (const name of names) {
    try {
      events.push(JSON.parse(await Deno.readTextFile(join(dir, name))));
    } catch (e) {
      console.warn(`Skipping malformed event file ${name}:`, e);
    }
  }
  return events;
}

export async function writeEvent(dir: string, event: EventData): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const basic = event.startAt.replaceAll(/[-:]/g, "");
  const path = join(dir, `${basic}-${crypto.randomUUID().slice(0, 8)}.json`);
  await Deno.writeTextFile(path, JSON.stringify(event));
  return path;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, content);
  await Deno.rename(tmp, path);
}

// --- The 6-week render window ------------------------------------------------

export function calendarWindow(
  today: Temporal.PlainDate,
): { from: Temporal.PlainDate; to: Temporal.PlainDate } {
  // Sunday's dayOfWeek is 7 but the grid starts the week on Sunday.
  const from = today.subtract({ days: today.dayOfWeek % 7 });
  return { from, to: from.add({ days: 41 }) };
}

export function inWindow(
  event: EventData,
  range: { from: Temporal.PlainDate; to: Temporal.PlainDate },
): boolean {
  const hasTime = event.startAt.includes("T");
  const zone = Temporal.Now.timeZoneId();
  const startDate = hasTime
    ? Temporal.Instant.from(event.startAt).toZonedDateTimeISO(zone).toPlainDate()
    : Temporal.PlainDate.from(event.startAt);
  // event.endAt is already exclusive for all-day events; a timed event can
  // still touch the local day its end instant falls in, so make that
  // exclusive too before comparing.
  const endExclusive = hasTime
    ? Temporal.Instant.from(event.endAt).toZonedDateTimeISO(zone).toPlainDate().add({ days: 1 })
    : Temporal.PlainDate.from(event.endAt);
  return Temporal.PlainDate.compare(startDate, range.to) <= 0 &&
    Temporal.PlainDate.compare(endExclusive, range.from) > 0;
}

// --- HTTP server --------------------------------------------------------------

const FORM_HTML = `
<details class=add-event>
<summary>Add event</summary>
<form method=post action="/events">
  <label class=field>
    Title
    <input type=text name=title required maxlength="200">
  </label>
  <div class=field-row>
    <label class=field>
      Date
      <input type=date name=date required>
    </label>
    <label class=field>
      Start
      <input type=time name=startTime>
    </label>
    <label class=field>
      End
      <input type=time name=endTime>
    </label>
  </div>
  <p class=hint>Leave the times blank for an all-day event.</p>
  <label class=field>
    Web page
    <input type=url name=url>
  </label>
  <label class=field>
    Image link
    <input type=url name=imageUrl>
  </label>
  <button type=submit>Add event</button>
</form>
</details>
`;

function renderErrorPage(message: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Could not add event</title></head>
  <body>
    <p>${escapeHtml(message)}</p>
    <p>Use your browser's back button to return to the form; your entries are preserved.</p>
  </body>
</html>
`;
}

export interface ServerConfig {
  eventsDir: string;
  outPath: string;
}

export function createApp(config: ServerConfig) {
  let queue: Promise<void> = Promise.resolve();

  async function doRerender(): Promise<void> {
    const range = calendarWindow(Temporal.Now.plainDateISO());
    const renderer = new CalendarRenderer(range.from.year, range);
    const events = (await loadEvents(config.eventsDir)).filter((e) => inWindow(e, range));
    const html = await renderer.render({ name: CALENDAR_NAME, events }, { form: FORM_HTML });
    await atomicWrite(config.outPath, html);
  }

  // Serialize rerenders: two concurrent POSTs must not interleave a read of
  // all events with a write of stale HTML. Never rejects, so that one failed
  // render cannot break the chain for later ones or take the process down as
  // an unhandled rejection from the midnight timer.
  function rerender(): Promise<Error | null> {
    const next: Promise<Error | null> = queue.then(doRerender).then(() => null, (e) => {
      console.error("rerender failed:", e);
      return e instanceof Error ? e : new Error(String(e));
    });
    queue = next.then(() => {});
    return next;
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      try {
        const html = await Deno.readFile(config.outPath);
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
          return new Response("Calendar not yet rendered.", { status: 503 });
        }
        throw e;
      }
    }

    if (req.method === "POST" && url.pathname === "/events") {
      const form = await req.formData();
      let event: EventData;
      try {
        event = formDataToEvent(form);
      } catch (e) {
        if (e instanceof ValidationError) {
          return new Response(renderErrorPage(e.message), {
            status: 400,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        throw e;
      }
      await writeEvent(config.eventsDir, event);
      const failure = await rerender();
      if (failure) {
        // The event file is already saved, so a later render will pick it up.
        return new Response(
          renderErrorPage("The event was saved, but the calendar could not be rerendered."),
          { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response(null, { status: 303, headers: { location: "/" } });
    }

    return new Response("Not found", { status: 404 });
  }

  return { handler, rerender };
}

function scheduleMidnightRerender(rerender: () => Promise<unknown>): void {
  const scheduleNext = () => {
    const now = Temporal.Now.zonedDateTimeISO();
    const midnight = now.toPlainDate().add({ days: 1 }).toZonedDateTime(now.timeZoneId);
    const delayMs = midnight.epochMilliseconds - now.epochMilliseconds;
    setTimeout(() => {
      rerender().finally(scheduleNext);
    }, delayMs);
  };
  scheduleNext();
}

if (import.meta.main) {
  let port = 8000;
  let outPath = join(import.meta.dirname!, "_site", "index.html");
  const eventsDir = join(import.meta.dirname!, "events");

  for (let i = 0; i < Deno.args.length; i++) {
    if (Deno.args[i] === "--port") {
      port = Number(Deno.args[++i]);
    } else if (Deno.args[i] === "--out") {
      outPath = Deno.args[++i];
    } else {
      console.error("usage: server.ts [--port N] [--out path]");
      Deno.exit(1);
    }
  }

  const app = createApp({ eventsDir, outPath });
  await app.rerender();
  scheduleMidnightRerender(app.rerender);
  Deno.serve({ port }, app.handler);
}
