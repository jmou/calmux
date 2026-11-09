# Calendar JSON Schema

```json
{
  "name": "Calendar Name",
  "events": [...]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Calendar display name |
| `events` | array | yes | List of events |

## Event

```json
{
  "title": "Event Title",
  "startAt": "20260101",
  "endAt": "20260102",
  "description": "Optional details",
  "url": "https://example.com",
  "imageUrl": "https://example.com/img.jpg",
  "categories": ["Tag"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Event title |
| `startAt` | string | yes | Start date/time (see below) |
| `endAt` | string | yes | End date/time (see below) |
| `description` | string | no | Event details |
| `url` | string | no | Event URL |
| `imageUrl` | string | no | Image URL |
| `categories` | string[] | no | Tags/categories |

## Date formats

- All-day event: `YYYYMMDD` — e.g. `20260101`
- Timed event: `YYYYMMDDTHHMMSSZ` (UTC) — e.g. `20260101T140000Z`
