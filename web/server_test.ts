import { join } from "@std/path";
import { assert, assertEquals, assertThrows } from "@std/assert";

import type { EventData } from "./main.ts";
import {
  calendarWindow,
  createApp,
  formDataToEvent,
  inWindow,
  loadEvents,
  ValidationError,
} from "./server.ts";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

Deno.test("formDataToEvent - a date plus both times produces a UTC instant", () => {
  const event = formDataToEvent(form({
    title: "Standup",
    date: "2026-08-24",
    startTime: "09:00",
    endTime: "09:15",
  }));
  assertEquals(event.title, "Standup");
  assert(event.startAt.includes("T"));
  assert(event.startAt.endsWith("Z"));
  assert(event.endAt.endsWith("Z"));
  // The instants land on the given date in the local zone.
  const zone = Temporal.Now.timeZoneId();
  const start = Temporal.Instant.from(event.startAt).toZonedDateTimeISO(zone);
  assertEquals(start.toPlainDate().toString(), "2026-08-24");
  assertEquals(start.toPlainTime().toString(), "09:00:00");
  assertEquals(
    Temporal.Instant.from(event.endAt).toZonedDateTimeISO(zone).toPlainTime().toString(),
    "09:15:00",
  );
});

Deno.test("formDataToEvent - no times makes an all-day event with an exclusive endAt", () => {
  const event = formDataToEvent(form({
    title: "Conference",
    date: "2026-08-24",
    startTime: "",
    endTime: "",
  }));
  assertEquals(event.startAt, "2026-08-24");
  assertEquals(event.endAt, "2026-08-25");
});

Deno.test("formDataToEvent - rejects only one of the two times", () => {
  const cases: Record<string, string>[] = [{ startTime: "09:00" }, { endTime: "09:15" }];
  for (const times of cases) {
    assertThrows(
      () => formDataToEvent(form({ title: "Standup", date: "2026-08-24", ...times })),
      ValidationError,
    );
  }
});

Deno.test("formDataToEvent - rejects a missing date", () => {
  assertThrows(
    () => formDataToEvent(form({ title: "Standup" })),
    ValidationError,
  );
});

Deno.test("formDataToEvent - blank optional fields are omitted, not empty", () => {
  const event = formDataToEvent(form({
    title: "Standup",
    date: "2026-08-24",
    startTime: "09:00",
    endTime: "09:15",
    description: "",
    url: "",
    imageUrl: "",
    categories: "",
  }));
  assertEquals(Object.keys(event).sort(), ["endAt", "startAt", "title"]);
});

Deno.test("formDataToEvent - categories are split, trimmed, and empties dropped", () => {
  const event = formDataToEvent(form({
    title: "Standup",
    date: "2026-08-24",
    startTime: "09:00",
    endTime: "09:15",
    categories: " Work, , Standup ,Daily",
  }));
  assertEquals(event.categories, ["Work", "Standup", "Daily"]);
});

Deno.test("formDataToEvent - rejects an empty title", () => {
  assertThrows(
    () =>
      formDataToEvent(form({
        title: "   ",
        date: "2026-08-24",
        startTime: "09:00",
        endTime: "09:15",
      })),
    ValidationError,
  );
});

Deno.test("formDataToEvent - rejects an end time before the start time", () => {
  assertThrows(
    () =>
      formDataToEvent(form({
        title: "Standup",
        date: "2026-08-24",
        startTime: "09:15",
        endTime: "09:00",
      })),
    ValidationError,
  );
});

Deno.test("formDataToEvent - rejects a javascript: url", () => {
  assertThrows(
    () =>
      formDataToEvent(form({
        title: "Standup",
        date: "2026-08-24",
        startTime: "09:00",
        endTime: "09:15",
        url: "javascript:alert(1)",
      })),
    ValidationError,
  );
});

Deno.test("formDataToEvent - rejects an unparseable date", () => {
  assertThrows(
    () =>
      formDataToEvent(form({
        title: "Standup",
        date: "not-a-date",
      })),
    ValidationError,
  );
});

Deno.test("POST /events with invalid data does not create the events dir", async () => {
  const dir = await Deno.makeTempDir({ dir: "." });
  try {
    const eventsDir = join(dir, "events");
    const outPath = join(dir, "index.html");
    const app = createApp({ eventsDir, outPath });

    const req = new Request("http://localhost/events", {
      method: "POST",
      body: new URLSearchParams({ title: "" }),
    });
    const res = await app.handler(req);
    assertEquals(res.status, 400);
    await res.body?.cancel();

    let exists = true;
    try {
      await Deno.stat(eventsDir);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      exists = false;
    }
    assert(!exists, "events dir should not have been created for a rejected submission");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("calendarWindow - today is a Sunday", () => {
  const today = Temporal.PlainDate.from("2026-08-23"); // dayOfWeek === 7
  const { from, to } = calendarWindow(today);
  assertEquals(from.toString(), "2026-08-23");
  assertEquals(from.until(to).days, 41);
});

Deno.test("calendarWindow - today is a Wednesday", () => {
  const today = Temporal.PlainDate.from("2026-08-26"); // dayOfWeek === 3
  const { from, to } = calendarWindow(today);
  assertEquals(from.toString(), "2026-08-23");
  assertEquals(from.until(to).days, 41);
});

Deno.test("calendarWindow - today is a Saturday", () => {
  const today = Temporal.PlainDate.from("2026-08-29"); // dayOfWeek === 6
  const { from, to } = calendarWindow(today);
  assertEquals(from.toString(), "2026-08-23");
  assertEquals(from.until(to).days, 41);
});

Deno.test("loadEvents - aggregates files in filename order and skips a malformed one", async () => {
  const dir = await Deno.makeTempDir({ dir: "." });
  try {
    await Deno.writeTextFile(
      join(dir, "20260825T090000Z-aaaaaaaa.json"),
      JSON.stringify(
        { title: "B", startAt: "2026-08-25T09:00:00Z", endAt: "2026-08-25T09:15:00Z" },
      ),
    );
    await Deno.writeTextFile(
      join(dir, "20260824T090000Z-bbbbbbbb.json"),
      JSON.stringify(
        { title: "A", startAt: "2026-08-24T09:00:00Z", endAt: "2026-08-24T09:15:00Z" },
      ),
    );
    await Deno.writeTextFile(join(dir, "broken.json"), "{not json");
    await Deno.writeTextFile(join(dir, "ignored.txt"), "should not be read");

    const events = await loadEvents(dir);
    assertEquals(events.map((e) => e.title), ["A", "B"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadEvents - a missing directory yields no events", async () => {
  const dir = await Deno.makeTempDir({ dir: "." });
  try {
    const events = await loadEvents(join(dir, "does-not-exist"));
    assertEquals(events, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inWindow - drops events outside the 6-week range", () => {
  const range = calendarWindow(Temporal.PlainDate.from("2026-08-23"));
  const inside: EventData = { title: "In", startAt: "2026-08-25", endAt: "2026-08-26" };
  const outside: EventData = { title: "Out", startAt: "2026-11-01", endAt: "2026-11-02" };
  assert(inWindow(inside, range));
  assert(!inWindow(outside, range));
});

Deno.test("end-to-end: POST writes the event, GET serves the rendered page", async () => {
  const dir = await Deno.makeTempDir({ dir: "." });
  try {
    const eventsDir = join(dir, "events");
    const outPath = join(dir, "index.html");
    const app = createApp({ eventsDir, outPath });
    await app.rerender();

    const server = Deno.serve({ port: 0, onListen: () => {} }, app.handler);
    const base = `http://localhost:${(server.addr as Deno.NetAddr).port}`;
    try {
      const today = Temporal.Now.plainDateISO().toString();
      const postRes = await fetch(`${base}/events`, {
        method: "POST",
        body: new URLSearchParams({
          title: "Smoke Test Event",
          date: today,
          startTime: "09:00",
          endTime: "09:15",
        }),
        redirect: "manual",
      });
      assertEquals(postRes.status, 303);
      assertEquals(postRes.headers.get("location"), "/");
      await postRes.body?.cancel();

      const getRes = await fetch(base);
      assertEquals(getRes.status, 200);
      const html = await getRes.text();
      assert(html.includes("Smoke Test Event"));
    } finally {
      await server.shutdown();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
