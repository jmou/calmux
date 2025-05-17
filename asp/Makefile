# https://www.nyc.gov/html/dot/html/motorist/alternate-side-parking.shtml
2025-alternate-side.ics:
	curl -fsSLo $@ https://www.nyc.gov/html/dot/downloads/misc/2025-alternate-side.ics

asp.json: extract_ics.py 2025-alternate-side.ics
	uv run $^ > $@
