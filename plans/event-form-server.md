# Plan: 6-week event calendar with an add-event form

## Goal

A small Deno HTTP server that:

- `POST /events` — writes the submitted event to its **own** JSON file, then
  **rerenders** the whole calendar page from the aggregate of every event file
  and writes it to disk. Redirects to `GET /`.
- `GET /` — serves that pre-rendered HTML file as static content. No rendering,
  no event-file reads, no template substitution on the request path.

Rendering reuses the existing `CalendarRenderer` + `web/template.html`
substitution — no view framework is introduced.

The calendar covers **6 full weeks starting from the week containing the render
date**. Under this architecture "as of rendering" is literal: the window is
fixed when the page is rendered, not when it is requested. See step 4 for how
the page is kept from going stale.

## Current state (what we build on)

- `web/main.ts` — `CalendarRenderer` turns `CalendarData` (`{name, events[]}`)
  into HTML by string-substituting `{{ name }}` and `{{ content }}` into
  `web/template.html`. Has a CLI entry point behind `import.meta.main` that
  already accepts `--from` / `--to`.
- `web/template.html` — full page: CSS grid calendar, day headers, tooltip JS.
- `docs/schema.md` — the `EventData` shape we must keep writing.
- `web/Makefile` — static build (`_site/index.html`) and snapshot tests.

The existing static build path must keep working unchanged; the server is
additive and happens to produce the same *kind* of artifact.

## Files

| File | Change |
|---|---|
| `web/server.ts` | **new** — HTTP server, form handling, event store, rerender |
| `web/events/` | **new** — one JSON file per user-submitted event |
| `web/events/.gitignore` | **new** — ignore `*.json` (local data, not source) |
| `web/template.html` | add `{{ form }}` placeholder + form styling |
| `web/main.ts` | generalize template substitution; fix template path & `$` escaping |
| `web/Makefile` | add `serve` target |
| `web/server_test.ts` | **new** — tests for the new logic |

Output HTML goes to `web/_site/index.html`, which is already gitignored
(`web/_site/.gitignore` is `*`).

---

## Step 1 — Make the template substitution reusable

`CalendarRenderer.render()` currently does:

```ts
const template = await Deno.readTextFile("template.html");
return template.replace("{{ name }}", name).replace("{{ content }}", content);
```

Three problems for server use:

1. **cwd-relative path.** The server may be launched from the repo root. Resolve
   against the module instead: `join(import.meta.dirname!, "template.html")`.
2. **`String.replace` treats `$` specially** in the replacement — an event titled
   `Buy 1 get 1 for $&` would corrupt the output today. Use a replacer *function*.
3. **No slot for the form.** The static `make` build must not emit a form.

Refactor to a single generic pass:

```ts
private static readonly PLACEHOLDER = /\{\{ (\w+) \}\}/g;

async render(data: CalendarData, extra: Record<string, string> = {}) {
  const template = await Deno.readTextFile(
    join(import.meta.dirname!, "template.html"),
  );
  const vars = { ...this.renderVariables(data), ...extra };
  return template.replace(
    CalendarRenderer.PLACEHOLDER,
    (_, key: string) => vars[key] ?? "",
  );
}
```

Unknown placeholders collapse to `""`, so the CLI/static build renders the page
with an empty form slot and no other change. **The `main_test.ts` snapshot will
need regenerating** (`make -C web update-snapshots`) — verify the diff is only
the removed `{{ form }}` line before accepting it.

## Step 2 — Add the form to `template.html`

Insert a `{{ form }}` placeholder above `<div class=calendar>` and have the
server fill it with a plain, no-JS `<form method=post action="/events">`:

- `title` — `text`, required
- `allDay` — `checkbox`
- `startAt` / `endAt` — `datetime-local`, required
- `startDate` / `endDate` — `date` (used when all-day; end is **inclusive**)
- `description` — `textarea`, optional
- `url`, `imageUrl` — `url`, optional
- `categories` — `text`, comma-separated, optional
- `<button type=submit>Add event</button>`

Because the page is rendered once and served to everyone, **the form markup is a
constant** — it cannot echo back one submitter's values. That is fine: it is a
static string in `server.ts`. It also means validation failures cannot be
reported by re-rendering the page with the bad values filled in (that would
leak one user's draft into the shared file). See step 5 for how errors are
reported instead.

Add a small `<style>` block to `template.html` for `form { … }` so the static
`make` page is unaffected when the slot is empty. A tiny inline script may
toggle the timed/all-day field pair, but the form must still submit correctly
with JS disabled — the server decides which fields to read from the `allDay`
checkbox, not from what the client hid.

## Step 3 — The event store (`web/events/`)

One event per file, containing exactly one `EventData` object per
`docs/schema.md`:

```json
{ "title": "Standup", "startAt": "2026-08-24T13:00:00Z", "endAt": "2026-08-24T13:15:00Z" }
```

**Filename:** `${startAtBasic}-${crypto.randomUUID().slice(0, 8)}.json`, e.g.
`20260824T130000Z-3f2a91cc.json`. Properties this buys us:

- Unique per submission → two concurrent POSTs can never clobber each other.
- Sorts chronologically by name, which makes directory listings readable and
  gives the aggregate a stable order before `CalendarRenderer` sorts it anyway.

**Writing:** `Deno.mkdir(dir, {recursive: true})` once at startup, then
`Deno.writeTextFile`.

**Reading:** `Deno.readDir` → keep `.json` entries → sort by name → read and
`JSON.parse` each. Skip and `console.warn` a file that fails to parse rather
than aborting the whole rerender; one bad file should not wedge the calendar.
`ENOENT` on the directory means "no events yet", not an error.

## Step 4 — Rendering, and when it happens

```ts
async function rerender() {
  const today = Temporal.Now.plainDateISO();
  // Sunday's dayOfWeek is 7 but the grid starts the week on Sunday.
  const weekStart = today.subtract({ days: today.dayOfWeek % 7 });
  const range = { from: weekStart, to: weekStart.add({ days: 41 }) };
  const renderer = new CalendarRenderer(weekStart.year, range);

  const events = (await loadEvents()).filter((e) => inWindow(e, range));
  const html = await renderer.render({ name: CALENDAR_NAME, events }, { form: FORM_HTML });
  await atomicWrite(outPath, html);
}
```

`from`/`to` already land exactly on week boundaries, so the constructor's
padding is a no-op and `calendarDays === 42` — the six full weeks asked for.
(The `year` argument is ignored when `range` is passed; pass `weekStart.year`
for honesty.)

**Filter events to the window** before rendering. Events outside it cannot
appear on the grid, but `decomposeMultiEdges` allocates placement edges for
every multi-day event regardless of visibility, so an out-of-window multi-day
event would otherwise reserve empty vertical space at the top of the page.

**`atomicWrite`** = write to `${out}.tmp-${uuid}` then `Deno.rename` into place.
Rename is atomic within a filesystem, so a concurrent `GET /` always reads
either the old complete page or the new one, never a truncated one.

### When rerender runs

1. **At startup** — so `GET /` has something to serve on a fresh checkout,
   before any POST.
2. **After each successful POST**, before responding.
3. **At each midnight**, via a timer scheduled to the next local midnight
   (recompute the delay after each fire rather than using a fixed 24h interval,
   so DST shifts do not drift it).

(3) is what keeps "6 weeks from the current week" honest on a long-lived
server. Without it, a server left running past Saturday would keep serving a
window that no longer starts with the current week, and `template.html`'s
`document.querySelector('[datetime="…"]').parentElement` for the `.today` class
would throw on a page whose grid no longer contains today. It is a few lines;
worth it. If you would rather not carry a timer, the fallback is to compare the
rendered window against today on `GET` and rerender when stale — but that puts
rendering back on the request path, which is what this design is avoiding.

**Serialize rerenders.** Two concurrent POSTs could interleave "read all events"
and "write HTML" such that the later write is from the earlier read, dropping an
event from the served page (the event *file* survives, so it reappears on the
next render — but the page is wrong until then). Guard with a one-line promise
chain: `queue = queue.then(rerender)`. No file locking needed.

## Step 5 — Request handling

`Deno.serve({ port })` with a single handler:

- **`GET /`** → `Deno.readFile(outPath)` → respond `text/html; charset=utf-8`
  with `cache-control: no-store` (the file changes underneath the same URL).
  On `ENOENT`, return `503` with a short "calendar not yet rendered" message —
  it should not happen given the startup render, but do not let it 500.
- **`POST /events`** → `await req.formData()`, validate, write event file,
  `await rerender()`, respond `303` with `location: /`. Post/Redirect/Get, so a
  refresh does not duplicate the event, and the redirect lands on a page that
  already includes the new event.
- anything else → `404`.

There are no other assets to serve — the CSS and JS are inline in
`template.html` — so a single-file read is enough; no `serveDir` needed.

### Parsing form input into `EventData`

This is the part most likely to go wrong; the conversions are not obvious:

- **Timed events.** `<input type=datetime-local>` submits `2026-08-24T09:00` —
  *no* offset. `main.ts`'s `localDateTime()` calls `Temporal.Instant.from()`,
  which **throws** on an offset-less string. Convert explicitly:

  ```ts
  Temporal.PlainDateTime.from(v).toZonedDateTime(Temporal.Now.timeZoneId())
    .toInstant().toString();
  ```

  Storing a UTC instant matches `docs/schema.md` and the existing feed data.
  Note this interprets the input in the *server's* zone, which is correct for a
  local-machine app; a hosted version would need the client to send its zone.

- **All-day events.** Store bare `YYYY-MM-DD` (no `T`) — that is how
  `renderVariables` routes an event to `DateEvent`. **`endAt` is exclusive**:
  `DateEvent.multiLength()` is `startDate.until(endDate).days` and
  `formatTime()` subtracts a day for display. So a one-day event on the 24th is
  `{startAt: "2026-08-24", endAt: "2026-08-25"}`. The form takes an *inclusive*
  end date (what a user means) and the server adds one day.

- **`startAt`/`endAt` must agree** on having a `T` — `renderVariables` throws
  `Date/DateTime mismatch` otherwise. The `allDay` checkbox drives both, so this
  is structurally guaranteed; assert it anyway before writing.

- `categories`: split on `,`, trim, drop empties. Omit the key entirely if empty
  rather than writing `[]`.
- Omit every optional key that is blank, so files stay minimal and match schema.

### Validation and error reporting

Validate **before** writing the event file, so a bad submission never enters the
store and never triggers a rerender. Reject with `400` and a small standalone
HTML page (generated inline in `server.ts`, not from `template.html`) stating
what was wrong plus a back link — the browser's back button preserves the typed
values. Rules:

- `title` non-empty after trim.
- `startAt`/`endAt` parse under `Temporal` — wrap in try/catch; `Temporal` throws
  `RangeError` on malformed input.
- `endAt >= startAt`.
- `url`/`imageUrl`, if present, must parse as a URL **and** be `http:`/`https:`.
  This matters: `renderEvent` puts `url` straight into `href`, so a
  `javascript:` value would be stored XSS baked into the served page.
  `escapeHtml` does not help there. Everything else is already escaped by the
  existing renderer.
- Cap `title`/`description` length (say 200/2000) so one submission cannot bloat
  the rendered page for everyone.

## Step 6 — Wiring

`web/Makefile`:

```make
serve:
	deno run --allow-net=0.0.0.0:8000 --allow-read=. --allow-write=events,_site server.ts

.PHONY: test update-snapshots serve
```

Narrow permissions are deliberate: the server writes *only* into `events/` and
`_site/`. Support `--port` and `--out` flags.

**Note the collision:** `make -C web _site/index.html` also writes
`_site/index.html`, from the scraped `merge.json` feeds. Running `make` while
the server is up will overwrite the server's page with the feed calendar (and
vice versa on the next POST). They are two different calendars sharing an
output path. If you want both, run the server with
`--out _site/events.html` and serve that. Defaulting to `index.html` is still
the right call — it is the obvious place and most users will only use one path.

`web/events/.gitignore` containing `*.json` — submitted events are local data,
mirroring how `_site/` and `merge.json` are already ignored.

## Step 7 — Tests (`web/server_test.ts`)

Unit-test the pure pieces; they hold all the subtle logic:

1. **`formDataToEvent`** — timed input produces a `Z` instant; all-day input
   produces bare dates with an exclusive `endAt` one day past the inclusive
   input; optional keys omitted when blank; `categories` split correctly.
2. **Validation** — empty title, `endAt` before `startAt`, `javascript:` URL,
   and unparseable dates each rejected, and each leaves `events/` untouched.
3. **Six-week range** — for a today that is a Sunday, a Wednesday, and a
   Saturday, `calendarStart` is that week's Sunday and the span is 42 days.
   (The recent "off-by-a-week padding when range starts/ends on Sunday" fix
   makes the Sunday case worth pinning down explicitly.)
4. **Aggregation** — a temp dir with several event files yields their union in
   filename order, and a malformed file is skipped rather than throwing.
5. **Window filter** — an event outside the 6 weeks is dropped before render.

An end-to-end test is more valuable under this design than it would be under
per-request rendering, because the write-then-serve split is where it can break:
start the server on port 0 into a temp dir, POST a form, assert `303`, then GET
`/` and assert the new title is in the *file-backed* response. Worth doing.

## Out of scope

Editing and deleting events, authentication, pagination/navigation to other
weeks, and merging the scraped `merge.json` feeds into the server's calendar.
The last one is a one-line change later (concatenate `merge.json`'s events into
the aggregate) if wanted.

## Risks / notes

- **Staleness is the central tradeoff** of serving static content: the page is
  only as current as the last render. The midnight timer in step 4 covers the
  window rolling forward; nothing else changes the page except a POST, so that
  is sufficient.
- **Snapshot churn** in step 1 is expected; review the diff rather than blindly
  accepting it.
- **No file locking** anywhere, and that is intentional — unique event
  filenames, atomic rename for the HTML, and a promise chain for rerenders
  cover every race.
- The server trusts its local caller. It is a local-first app; do not expose it
  publicly without adding CSRF protection to the POST and rate-limiting writes,
  since every submission creates a file and triggers a full rerender.
