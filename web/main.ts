interface EventData {
  title: string;
  startAt: string;
  endAt: string;
  description?: string;
  url?: string;
  imageUrl?: string;
  categories?: string[];
}

interface CalendarData {
  name: string;
  events: EventData[];
}

function localDateTime(iso: string) {
  return Temporal.Instant.from(iso).toZonedDateTimeISO(
    Temporal.Now.timeZoneId(),
  );
}

function formatMonDate(date: Temporal.PlainDate) {
  // toLocaleString() returns in the format "Jan 1, 2025", but the year should
  // not be included. Explicitly remove it.
  // See https://github.com/denoland/deno/issues/26076
  const s = date.toLocaleString("en-US", { month: "short", day: "numeric" });
  return s.split(",")[0];
}

function formatBriefTime(time: Temporal.PlainTime) {
  const s = time
    .toLocaleString([], { hour: "numeric", minute: "numeric" })
    // Explicitly remove seconds from toLocaleString() result.
    .toLowerCase().replace(/:\d\d\s/, "").replace(":00", "");
  if (s === "12pm") return "noon";
  return s;
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

abstract class Event {
  constructor(protected readonly data: EventData) {}

  abstract get startDate(): Temporal.PlainDate;
  abstract get endDate(): Temporal.PlainDate;

  // If the event should span multiple grid cells, return the number of cells to
  // span. Otherwise for an event within a single day, return 0.
  abstract multiLength(): number;

  compare(other: Event) {
    let rc = this.data.startAt.localeCompare(other.data.startAt);
    if (rc != 0) return rc;
    rc = -this.data.endAt.localeCompare(other.data.endAt);
    if (rc != 0) return rc;
    return this.data.title.localeCompare(other.data.title);
  }

  protected abstract formatTime(): string;
  abstract renderHeadline(): string;

  renderTitleAttr() {
    const title = `${escapeHtml(this.data.title)}\n${(this).formatTime()}`;
    if (this.data.description == null) return title;
    return `${title}\n${escapeHtml(this.data.description)}`;
  }
}

class DateEvent extends Event {
  get startDate() {
    return Temporal.PlainDate.from(this.data.startAt);
  }

  get endDate() {
    return Temporal.PlainDate.from(this.data.endAt);
  }

  multiLength() {
    return this.startDate.until(this.endDate).days;
  }

  protected formatTime() {
    const inclusiveEnd = this.endDate.subtract({ days: 1 });
    if (this.startDate.equals(inclusiveEnd)) {
      return formatMonDate(this.startDate);
    } else if (
      this.startDate.with({ day: inclusiveEnd.day }).equals(inclusiveEnd)
    ) {
      return `${formatMonDate(this.startDate)}&ndash;${inclusiveEnd.day}`;
    } else {
      return `${formatMonDate(this.startDate)}&ndash;${
        formatMonDate(inclusiveEnd)
      }`;
    }
  }

  renderHeadline() {
    return escapeHtml(this.data.title);
  }
}

class DateTimeEvent extends Event {
  private get startAt() {
    return localDateTime(this.data.startAt);
  }

  private get endAt() {
    return localDateTime(this.data.endAt);
  }

  get startDate() {
    return this.startAt.toPlainDate();
  }

  get endDate() {
    return this.endAt.toPlainDate();
  }

  multiLength() {
    if (this.startDate.equals(this.endDate)) return 0;
    // Google Calendar includes the end day if past noon.
    return this.endAt.add({ hours: 12 }).toPlainDate()
      .since(this.startDate).days;
  }

  private get briefStartTime() {
    return formatBriefTime(this.startAt.toPlainTime());
  }

  protected formatTime() {
    const prettyStartDate = formatMonDate(this.startDate);
    const prettyEndDate = formatMonDate(this.endDate);
    const briefEndTime = formatBriefTime(this.endAt.toPlainTime());
    return this.startDate.equals(this.endDate)
      ? `${prettyStartDate} ${this.briefStartTime}&ndash;${briefEndTime}`
      : `${prettyStartDate} ${this.briefStartTime}&ndash;${prettyEndDate} ${briefEndTime}`;
  }

  renderHeadline() {
    const ts = this.startAt.toString({ timeZoneName: "never" });
    return `
      <time datetime="${ts}">${this.briefStartTime}</time>
      ${escapeHtml(this.data.title)}
    `;
  }
}

interface MultiEventEdge {
  gridOrd: number;
  event: Event;
  prev: MultiEventEdge | null;
  definite: boolean;
  place?: number;
}

export class CalendarRenderer {
  private calendarStart: Temporal.PlainDate;
  private calendarDays: number;

  constructor(year: number) {
    const jan1 = new Temporal.PlainDate(year, 1, 1);
    this.calendarStart = jan1.subtract({ days: jan1.dayOfWeek });

    const dec31 = new Temporal.PlainDate(year, 12, 31);
    const inclusiveEnd = dec31.add({ days: 6 - dec31.dayOfWeek });
    this.calendarDays = this.calendarStart.until(inclusiveEnd).days + 1;
  }

  private gridOrd(date: Temporal.PlainDate) {
    return date.since(this.calendarStart).days;
  }

  private gridRow(ord: number) {
    return Math.floor(ord / 7) + 2;
  }

  private gridCol(ord: number) {
    return ord % 7 + 1;
  }

  private renderDay(
    ord: number,
    stack: Event[],
    ensureMonth: boolean,
    space: number,
  ) {
    const date = this.calendarStart.add({ days: ord });
    ensureMonth ||= date.day === 1;
    const text = ensureMonth ? formatMonDate(date) : date.day.toString();

    const content = [];
    if (space > 0) {
      content.push(`<div class=space style="--num-places: ${space}"></div>`);
    }
    while (stack.at(-1)?.startDate?.equals(date)) {
      const event = stack.pop() as Event;
      content.push(`
        <div class=event title="${event.renderTitleAttr()}">
          ${event.renderHeadline()}
        </div>
      `);
    }

    const row = this.gridRow(ord);
    const col = this.gridCol(ord);
    const classes = ["day"];
    if (date.day <= 7) classes.push("first-week");
    return `
      <div class="${classes.join(" ")}" style="grid-area: ${row} / ${col}">
        <time datetime=${date}>${text}</time>
        ${content.join("")}
      </div>
    `;
  }

  private decomposeMultiEdges(events: Event[]): MultiEventEdge[] {
    const edges = [];
    for (const event of events) {
      // Leading edge.
      const start = this.gridOrd(event.startDate);
      let prev = { gridOrd: start, event, prev: null, definite: true };
      edges.push(prev);

      // Add indefinite edges (week boundaries) starting from Sunday.
      const followingSunday = start - (start % 7) + 7;
      const end = start + event.multiLength();
      for (let gridOrd = followingSunday; gridOrd < end; gridOrd += 7) {
        edges.push({ gridOrd, event, prev, definite: false });
        prev = { gridOrd, event, prev: null, definite: false };
        edges.push(prev);
      }

      // Final trailing edge.
      edges.push({ gridOrd: end, event, prev, definite: true });
    }
    return edges;
  }

  private compareMultiEdge(a: MultiEventEdge, b: MultiEventEdge) {
    // Date ascending.
    if (a.gridOrd != b.gridOrd) return a.gridOrd < b.gridOrd ? -1 : 1;
    // Close then open.
    if (a.prev != b.prev) return a.prev != null ? -1 : 1;
    // Indefinite then definite.
    if (a.definite != b.definite) return !a.definite ? -1 : 1;
    // Compare the rest of the event, mostly to keep sorting more stable.
    return a.event.compare(b.event);
  }

  private placeMultiEdges(edges: MultiEventEdge[]) {
    const allocatedSpace = [];
    const places = [];
    for (const edge of edges) {
      const { gridOrd, prev } = edge;
      if (prev == null) {
        let place = 0;
        while (place < places.length && places[place] != null) place++;
        places[place] = true;
        edge.place = place;
        allocatedSpace[gridOrd] = places.length;
      } else if (prev.place != null) {
        console.assert(places[prev.place]);
        delete places[prev.place];
        while (places.length > 0 && places.at(-1) == null) places.pop();
        allocatedSpace[gridOrd] = places.length;
      }
    }
    return allocatedSpace;
  }

  private renderMultiEdge(edge: MultiEventEdge) {
    if (edge.prev == null) return "";
    const { event, prev } = edge;
    console.assert(prev.place != null);

    const row = this.gridRow(prev.gridOrd);
    const left = this.gridCol(prev.gridOrd);
    const inclusiveEnd = edge.gridOrd - 1;
    console.assert(row === this.gridRow(inclusiveEnd));
    const right = this.gridCol(inclusiveEnd) + 1;
    const gridArea = `${row} / ${left} / ${row} / ${right}`;

    const classes = ["event", "multi"];
    if (!prev.definite) classes.push("indefinite-start");
    if (!edge.definite) classes.push("indefinite-end");
    return `
      <div class="${classes.join(" ")}"
           style="grid-area: ${gridArea}; --place: ${prev.place}"
           title="${event.renderTitleAttr()}">
        ${event.renderHeadline()}
      </div>
    `;
  }

  private renderVariables(data: CalendarData) {
    const normal: DateTimeEvent[] = [];
    const multi: Event[] = [];
    for (const eventData of data.events) {
      const hasTime = eventData.startAt.includes("T");
      if (eventData.endAt.includes("T") != hasTime) {
        throw new Error("Date/DateTime mismatch");
      }
      if (hasTime) {
        const event = new DateTimeEvent(eventData);
        const queue = event.multiLength() > 0 ? multi : normal;
        queue.push(event);
      } else {
        multi.push(new DateEvent(eventData));
      }
    }

    // Place multi events first, so we know how much space to allocate for them
    // on the grid.
    const edges = this.decomposeMultiEdges(multi);
    edges.sort(this.compareMultiEdge);
    const allocatedSpace = this.placeMultiEdges(edges);

    // Render the calendar grid and normal events.
    const content = [];
    normal.sort((a, b) => b.compare(a)); // earliest events at top of stack
    let space = 0;
    for (let i = 0; i < this.calendarDays; i++) {
      if (allocatedSpace[i] != null) space = allocatedSpace[i];
      content.push(this.renderDay(i, normal, i === 0, space));
    }

    // Render multi events over the calendar.
    for (const edge of edges) {
      content.push(this.renderMultiEdge(edge));
    }

    return {
      name: data.name,
      content: content.join(""),
    };
  }

  async render(data: CalendarData) {
    const template = await Deno.readTextFile("template.html");
    const { name, content } = this.renderVariables(data);
    return template
      .replace("{{ name }}", name)
      .replace("{{ content }}", content);
  }
}

if (import.meta.main) {
  if (Deno.args.length !== 1) {
    console.error("usage: main.ts calendar.json");
    Deno.exit(1);
  }

  const data = JSON.parse(Deno.readTextFileSync(Deno.args[0]));
  const renderer = new CalendarRenderer(2025);

  console.log(await renderer.render(data));
}
