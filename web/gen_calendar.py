import calendar
import html
import json
import re
import sys
from datetime import date, datetime

STYLES = """
article {
    border: 1px solid black;
}
article + article {
    margin-top: .5em;
}
.month {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
}
.day:first-child {
    grid-column: var(--first-column);
}
.day {
    min-height: 2em;
}
.today {
    background: #ddd;
    > time { font-weight: bold; }
}
"""


def format_time(t: datetime):
    s = t.strftime("%l:%M %p").lower().strip()
    s = s.replace(":00", "")
    if s == "12 pm":
        s = "noon"
    return f"<time datetime={t.isoformat()}>{s}</time>"


def format_time_range(start: datetime, end: datetime):
    s = f"{format_time(start)}&ndash;{format_time(end)}"
    return re.sub(r"( [ap]m)(.*&ndash;.*\1)", r"\2", s)


def render_event(event: dict):
    if "description" in event:
        print(f'<div title="{html.escape(event["description"])}">')
    else:
        print("<div>")
    all_day = "T" not in event["startAt"]
    if all_day:
        start = date.fromisoformat(event["startAt"])
        end = date.fromisoformat(event["endAt"])
        # TODO support multi-day events
        assert (end - start).days == 1
    else:
        start = datetime.fromisoformat(event["startAt"]).astimezone()
        end = datetime.fromisoformat(event["endAt"]).astimezone()
        # TODO support events crossing midnight
        assert start.date() == end.date()
        print(format_time_range(start, end))
    print(event["title"])
    print("</div>")


def render_month(year: int, month: int, events: list):
    first_dow, ndays = calendar.monthrange(year, month)
    first_column = (first_dow + 1) % 7 + 1
    print("<article>")
    print("<header>")
    first = date(year, month, 1)
    print(first.strftime("%B %Y"))
    print("</header>")
    print(f'<div class=month style="--first-column: {first_column}">')
    for day in range(1, ndays + 1):
        dt = date(year, month, day)
        print("<div class=day>")
        print(f"<time datetime={dt.isoformat()}>")
        print(day)
        print("</time>")
        while events and events[-1]["startAt"].startswith(dt.strftime("%Y%m%d")):
            render_event(events.pop())
        print("</div>")
    print("</div>")
    print("</article>")


def render_year(year: int, events: list):
    for month in range(1, 13):
        render_month(year, month, events)


if __name__ == "__main__":
    _, cal_file = sys.argv
    with open(cal_file) as fh:
        cal = json.load(fh)
    print("<!doctype html>")
    print("<html>")
    print("<head>")
    print("<title>Calendar</title>")
    print("<style>")
    print(STYLES)
    print("</style>")
    print("</head>")
    print("<body>")
    print(f'<h1>{cal["name"]}</h1>')
    cal["events"].sort(key=lambda x: x["startAt"], reverse=True)
    render_year(2025, cal["events"])
    print("<script>")
    # Hackily relies on en-CA locale date format to be %Y-%m-%d.
    print('const today = new Date().toLocaleDateString("en-CA");')
    print(
        'document.querySelector(`[datetime="${today}"]`).parentElement.classList.add("today");'
    )
    print("</script>")
    print("</body>")
    print("</html>")
