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

  abstract get multi(): boolean;

  abstract get startDate(): Temporal.PlainDate;
  abstract get endDate(): Temporal.PlainDate;

  get gridStart() {
    return this.startDate;
  }

  abstract get gridEnd(): Temporal.PlainDate;

  protected abstract formatTime(): string;
  abstract renderHeadline(): string;

  renderTitleAttr() {
    const title = `${escapeHtml(this.data.title)}\n${(this).formatTime()}`;
    if (this.data.description == null) return title;
    return `${title}\n${escapeHtml(this.data.description)}`;
  }
}

class DateEvent extends Event {
  get multi() {
    return true;
  }

  get startDate() {
    return Temporal.PlainDate.from(this.data.startAt);
  }

  get endDate() {
    // Make end date inclusive.
    return Temporal.PlainDate.from(this.data.endAt).subtract({ days: 1 });
  }

  get gridEnd() {
    return this.endDate;
  }

  protected formatTime() {
    if (this.startDate.equals(this.endDate)) {
      return formatMonDate(this.startDate);
    } else if (
      this.startDate.with({ day: this.endDate.day }).equals(this.endDate)
    ) {
      return `${formatMonDate(this.startDate)}&ndash;${this.endDate.day}`;
    } else {
      return `${formatMonDate(this.startDate)}&ndash;${
        formatMonDate(this.endDate)
      }`;
    }
  }

  renderHeadline() {
    return escapeHtml(this.data.title);
  }
}

class DateTimeEvent extends Event {
  get multi() {
    return !this.gridStart.equals(this.gridEnd);
  }

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

  get gridEnd() {
    return this.startDate.equals(this.endDate)
      ? this.endDate
      // Google Calendar includes the end day if past noon.
      : this.endAt.subtract({ hours: 12 }).toPlainDate();
  }

  compare(other: DateTimeEvent) {
    return Temporal.ZonedDateTime.compare(this.startAt, other.startAt);
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

export class CalendarRenderer {
  private calendarStart: Temporal.PlainDate;
  private calendarDays: number;

  constructor(year: number, private data: CalendarData) {
    const jan1 = new Temporal.PlainDate(year, 1, 1);
    this.calendarStart = jan1.subtract({ days: jan1.dayOfWeek });
    const dec31 = new Temporal.PlainDate(year, 12, 31);
    const limit = dec31.add({ days: 6 - dec31.dayOfWeek });
    this.calendarDays = this.calendarStart.until(limit).days;
  }

  private gridCoords(date: Temporal.PlainDate) {
    const index = date.since(this.calendarStart).days;
    const row = Math.floor(index / 7) + 1;
    const col = index % 7 + 1;
    return { row, col };
  }

  private renderDay(
    day: Temporal.PlainDate,
    stack: Event[],
    includeMonth: boolean,
  ) {
    const text = includeMonth ? formatMonDate(day) : day.day.toString();
    const events = [];
    while (stack.at(-1)?.startDate?.equals(day)) {
      const event = stack.pop() as Event;
      events.push(`
        <div class=event title="${event.renderTitleAttr()}">
          ${event.renderHeadline()}
        </div>
      `);
    }
    const { row, col } = this.gridCoords(day);
    return `
      <div class=day style="grid-area: ${row} / ${col}">
        <time datetime=${day}>${text}</time>
        ${events.join("")}
      </div>
    `;
  }

  private renderMultiDayEvent(event: Event) {
    const start = this.gridCoords(event.gridStart);
    const end = this.gridCoords(event.gridEnd);
    const result = [];
    for (let row = start.row; row <= end.row; row++) {
      const left = row == start.row ? start.col : 1;
      const right = row == end.row ? end.col + 1 : -1;
      result.push(`
        <div class="event multi" style="--index: 0"
             data-area="${row} / ${left} / ${row} / ${right}"
             title="${event.renderTitleAttr()}">
          ${event.renderHeadline()}
        </div>
      `);
    }
    return result.join("");
  }

  private renderVariables() {
    const normal: DateTimeEvent[] = [];
    const multi: Event[] = [];
    for (const eventData of this.data.events) {
      const hasTime = eventData.startAt.includes("T");
      if (eventData.endAt.includes("T") != hasTime) {
        throw new Error("Date/DateTime mismatch");
      }
      if (hasTime) {
        const event = new DateTimeEvent(eventData);
        const queue = event.multi ? multi : normal;
        queue.push(event);
      } else {
        multi.push(new DateEvent(eventData));
      }
    }
    // Soonest events at top of stack.
    normal.sort((a, b) => b.compare(a));

    const content = [];

    for (let i = 0; i < this.calendarDays; i++) {
      const day = this.calendarStart.add({ days: i });
      const includeMonth = day.day === 1 || day.equals(this.calendarStart);
      content.push(this.renderDay(day, normal, includeMonth));
    }

    for (const event of multi) {
      content.push(this.renderMultiDayEvent(event));
    }

    return {
      name: this.data.name,
      content: content.join(""),
    };
  }

  async render() {
    const template = await Deno.readTextFile("template.html");
    const { name, content } = this.renderVariables();
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
  const renderer = new CalendarRenderer(2025, data);

  console.log(await renderer.render());
}
