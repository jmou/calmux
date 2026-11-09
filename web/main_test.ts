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
