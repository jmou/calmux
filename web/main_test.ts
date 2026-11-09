import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { snapshot, test } from "node:test";
import { inspect } from "node:util";

import { CalendarRenderer } from "./main.ts";

// Keep snapshots in __snapshots__/ beside their inputs, rather than next to the
// test file where node:test would otherwise put them.
snapshot.setResolveSnapshotPath((testFile) =>
  join(import.meta.dirname, "__snapshots__", `${basename(testFile ?? "test")}.snapshot`)
);

// Store rendered HTML verbatim instead of as one escaped JSON line, so the
// snapshot stays diffable.
snapshot.setDefaultSnapshotSerializers([
  (value) => (typeof value === "string" ? value : inspect(value)),
]);

test("isSnapshotMatch", async (t) => {
  const data = JSON.parse(
    readFileSync(join(import.meta.dirname, "__snapshots__/inputs/asp-fgpc.json"), "utf-8"),
  );
  const renderer = new CalendarRenderer(2025);
  t.assert.snapshot(await renderer.render(data));
});

test("skips events outside the range and clips straddling ones", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const assert = t.mock.method(console, "assert");
  const renderer = new CalendarRenderer(2025, {
    // The grid pads to whole weeks: Sun Apr 20 – Sat May 3.
    from: Temporal.PlainDate.from("2025-04-20"),
    to: Temporal.PlainDate.from("2025-05-03"),
  });
  const html = await renderer.render({
    name: "test",
    events: [
      { title: "Before", startAt: "20250101", endAt: "20250102" },
      { title: "Straddle", startAt: "20250419", endAt: "20250422" },
      { title: "Inside", startAt: "20250425", endAt: "20250426" },
      { title: "After", startAt: "20251225", endAt: "20251226" },
      {
        title: "Timed after",
        startAt: "2025-06-01T16:00:00Z",
        endAt: "2025-06-01T17:00:00Z",
      },
    ],
  });

  t.assert.deepStrictEqual(
    warn.mock.calls.map((c) => c.arguments),
    [["Skipped 3 event(s) outside 2025-04-20..2025-05-03"]],
  );
  t.assert.ok(assert.mock.calls.every((c) => c.arguments[0]));
  t.assert.match(html, /class="event multi indefinite-start"[^>]*Straddle/);
  t.assert.match(html, /Inside/);
  t.assert.doesNotMatch(html, /Before|After/);
});
