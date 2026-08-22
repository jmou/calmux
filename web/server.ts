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

function parseLocalDateTime(raw: string, field: string): Temporal.ZonedDateTime {
  try {
    return Temporal.PlainDateTime.from(raw).toZonedDateTime(Temporal.Now.timeZoneId());
  } catch {
    throw new ValidationError(`${field} is invalid.`);
  }
}

function parseTimedRange(form: FormData): { startAt: string; endAt: string } {
  const start = parseLocalDateTime(getTrimmed(form, "startAt"), "Start time").toInstant();
  const end = parseLocalDateTime(getTrimmed(form, "endAt"), "End time").toInstant();
  if (Temporal.Instant.compare(end, start) < 0) {
    throw new ValidationError("End time must not be before start time.");
  }
  return { startAt: start.toString(), endAt: end.toString() };
}

function parseAllDayRange(form: FormData): { startAt: string; endAt: string } {
  const start = parseDate(getTrimmed(form, "startDate"), "Start date");
  // The form's end date is inclusive; DateEvent's endAt is exclusive.
  const inclusiveEnd = parseDate(getTrimmed(form, "endDate"), "End date");
  if (Temporal.PlainDate.compare(inclusiveEnd, start) < 0) {
    throw new ValidationError("End date must not be before start date.");
  }
  return { startAt: start.toString(), endAt: inclusiveEnd.add({ days: 1 }).toString() };
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

  const allDay = form.get("allDay") != null;
  const { startAt, endAt } = allDay ? parseAllDayRange(form) : parseTimedRange(form);
  // Structurally guaranteed by the branch above; assert it anyway.
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

  const url = parseOptionalUrl(form, "url", "URL");
  if (url) event.url = url;
  const imageUrl = parseOptionalUrl(form, "imageUrl", "Image URL");
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
<form method=post action="/events">
  <label class=field>
    Title
    <input type=text name=title required maxlength="200">
  </label>
  <label class=field-inline>
    <input type=checkbox name=allDay id=form-all-day>
    All day
  </label>
  <div class=field-row data-role=timed>
    <label class=field>
      Start
      <input type=datetime-local name=startAt required>
    </label>
    <label class=field>
      End
      <input type=datetime-local name=endAt required>
    </label>
  </div>
  <div class=field-row data-role=all-day hidden>
    <label class=field>
      Start date
      <input type=date name=startDate>
    </label>
    <label class=field>
      End date (inclusive)
      <input type=date name=endDate>
    </label>
  </div>
  <label class=field>
    Description
    <textarea name=description maxlength="2000"></textarea>
  </label>
  <label class=field>
    URL
    <input type=url name=url>
  </label>
  <label class=field>
    Image URL
    <input type=url name=imageUrl>
  </label>
  <label class=field>
    Categories
    <input type=text name=categories placeholder="comma, separated">
  </label>
  <button type=submit>Add event</button>
</form>
<script>
  {
    const form = document.currentScript.previousElementSibling;
    const allDay = form.querySelector("#form-all-day");
    const timed = form.querySelector("[data-role=timed]");
    const dateRow = form.querySelector("[data-role=all-day]");
    const sync = () => {
      timed.hidden = allDay.checked;
      dateRow.hidden = !allDay.checked;
    };
    allDay.addEventListener("change", sync);
    sync();
  }
</script>
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
