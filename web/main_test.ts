import { assertSnapshot } from "jsr:@std/testing/snapshot";

import { CalendarRenderer } from "./main.ts";

Deno.test("isSnapshotMatch", async (t) => {
  const data = JSON.parse(
    Deno.readTextFileSync("__snapshots__/inputs/asp-fgpc.json"),
  );
  const renderer = new CalendarRenderer(2025, data);
  await assertSnapshot(t, await renderer.render());
});
