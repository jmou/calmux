# /// script
# dependencies = [
#     "icalendar",
#     "recurring-ical-events",
# ]
# ///

import json
import sys
from pathlib import Path

import icalendar
import recurring_ical_events


def parse_event(event: icalendar.Component):
    return {
        "title": event["SUMMARY"],
        "description": event["DESCRIPTION"],
        "startAt": event["DTSTART"].to_ical().decode("ascii"),
        "endAt": event["DTEND"].to_ical().decode("ascii"),
    }


if __name__ == "__main__":
    _, ics_file = sys.argv
    cal = icalendar.Calendar.from_ical(Path(ics_file).read_text())
    data = {"name": cal["X-WR-CALNAME"], "events": []}
    for event in recurring_ical_events.of(cal).at(2025):
        data["events"].append(parse_event(event))
    json.dump(data, sys.stdout, indent=2)
    print()
