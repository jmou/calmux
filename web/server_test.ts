import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { serve } from "./http.ts";
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

test("formDataToEvent - a date plus both times produces a UTC instant", () => {
  const event = formDataToEvent(form({
    title: "Standup",
    date: "2026-08-24",
    startTime: "09:00",
    endTime: "09:15",
  }));
  assert.deepEqual(event.title, "Standup");
  assert.ok(event.startAt.includes("T"));
  assert.ok(event.startAt.endsWith("Z"));
  assert.ok(event.endAt.endsWith("Z"));
  // The instants land on the given date in the local zone.
  const zone = Temporal.Now.timeZoneId();
  const start = Temporal.Instant.from(event.startAt).toZonedDateTimeISO(zone);
  assert.deepEqual(start.toPlainDate().toString(), "2026-08-24");
  assert.deepEqual(start.toPlainTime().toString(), "09:00:00");
  assert.deepEqual(
    Temporal.Instant.from(event.endAt).toZonedDateTimeISO(zone).toPlainTime().toString(),
    "09:15:00",
  );
});

test("formDataToEvent - no times makes an all-day event with an exclusive endAt", () => {
  const event = formDataToEvent(form({
    title: "Conference",
    date: "2026-08-24",
    startTime: "",
    endTime: "",
  }));
  assert.deepEqual(event.startAt, "2026-08-24");
  assert.deepEqual(event.endAt, "2026-08-25");
});

test("formDataToEvent - rejects only one of the two times", () => {
  const cases: Record<string, string>[] = [{ startTime: "09:00" }, { endTime: "09:15" }];
  for (const times of cases) {
    assert.throws(
      () => formDataToEvent(form({ title: "Standup", date: "2026-08-24", ...times })),
      ValidationError,
    );
  }
});

test("formDataToEvent - rejects a missing date", () => {
  assert.throws(
    () => formDataToEvent(form({ title: "Standup" })),
    ValidationError,
  );
});

test("formDataToEvent - blank optional fields are omitted, not empty", () => {
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
  assert.deepEqual(Object.keys(event).sort(), ["endAt", "startAt", "title"]);
});

test("formDataToEvent - categories are split, trimmed, and empties dropped", () => {
  const event = formDataToEvent(form({
    title: "Standup",
    date: "2026-08-24",
    startTime: "09:00",
    endTime: "09:15",
    categories: " Work, , Standup ,Daily",
  }));
  assert.deepEqual(event.categories, ["Work", "Standup", "Daily"]);
});

test("formDataToEvent - rejects an empty title", () => {
  assert.throws(
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

test("formDataToEvent - rejects an end time before the start time", () => {
  assert.throws(
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

test("formDataToEvent - rejects a javascript: url", () => {
  assert.throws(
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

test("formDataToEvent - rejects an unparseable date", () => {
  assert.throws(
    () =>
      formDataToEvent(form({
        title: "Standup",
        date: "not-a-date",
      })),
    ValidationError,
  );
});

test("POST /events with invalid data does not create the events dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "calmux-"));
  try {
    const eventsDir = join(dir, "events");
    const outPath = join(dir, "index.html");
    const app = createApp({ eventsDir, outPath });

    const req = new Request("http://localhost/events", {
      method: "POST",
      body: new URLSearchParams({ title: "" }),
    });
    const res = await app.handler(req);
    assert.deepEqual(res.status, 400);
    await res.body?.cancel();

    let exists = true;
    try {
      await stat(eventsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      exists = false;
    }
    assert.ok(!exists, "events dir should not have been created for a rejected submission");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("calendarWindow - today is a Sunday", () => {
  const today = Temporal.PlainDate.from("2026-08-23"); // dayOfWeek === 7
  const { from, to } = calendarWindow(today);
  assert.deepEqual(from.toString(), "2026-08-23");
  assert.deepEqual(from.until(to).days, 41);
});

test("calendarWindow - today is a Wednesday", () => {
  const today = Temporal.PlainDate.from("2026-08-26"); // dayOfWeek === 3
  const { from, to } = calendarWindow(today);
  assert.deepEqual(from.toString(), "2026-08-23");
  assert.deepEqual(from.until(to).days, 41);
});

test("calendarWindow - today is a Saturday", () => {
  const today = Temporal.PlainDate.from("2026-08-29"); // dayOfWeek === 6
  const { from, to } = calendarWindow(today);
  assert.deepEqual(from.toString(), "2026-08-23");
  assert.deepEqual(from.until(to).days, 41);
});

test("loadEvents - aggregates files in filename order and skips a malformed one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "calmux-"));
  try {
    await writeFile(
      join(dir, "20260825T090000Z-aaaaaaaa.json"),
      JSON.stringify(
        { title: "B", startAt: "2026-08-25T09:00:00Z", endAt: "2026-08-25T09:15:00Z" },
      ),
    );
    await writeFile(
      join(dir, "20260824T090000Z-bbbbbbbb.json"),
      JSON.stringify(
        { title: "A", startAt: "2026-08-24T09:00:00Z", endAt: "2026-08-24T09:15:00Z" },
      ),
    );
    await writeFile(join(dir, "broken.json"), "{not json");
    await writeFile(join(dir, "ignored.txt"), "should not be read");

    const events = await loadEvents(dir);
    assert.deepEqual(events.map((e) => e.title), ["A", "B"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("loadEvents - a missing directory yields no events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "calmux-"));
  try {
    const events = await loadEvents(join(dir, "does-not-exist"));
    assert.deepEqual(events, []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("inWindow - drops events outside the 6-week range", () => {
  const range = calendarWindow(Temporal.PlainDate.from("2026-08-23"));
  const inside: EventData = { title: "In", startAt: "2026-08-25", endAt: "2026-08-26" };
  const outside: EventData = { title: "Out", startAt: "2026-11-01", endAt: "2026-11-02" };
  assert.ok(inWindow(inside, range));
  assert.ok(!inWindow(outside, range));
});

test("end-to-end: POST writes the event, GET serves the rendered page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "calmux-"));
  try {
    const eventsDir = join(dir, "events");
    const outPath = join(dir, "index.html");
    const app = createApp({ eventsDir, outPath });
    await app.rerender();

    const server = await serve(app.handler, { port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${server.port}`;
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
      assert.deepEqual(postRes.status, 303);
      assert.deepEqual(postRes.headers.get("location"), "/");
      await postRes.body?.cancel();

      const getRes = await fetch(base);
      assert.deepEqual(getRes.status, 200);
      const html = await getRes.text();
      assert.ok(html.includes("Smoke Test Event"));
    } finally {
      await server.shutdown();
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});
