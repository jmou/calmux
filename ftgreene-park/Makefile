URL = https://www.fortgreenepark.org/calendar

cal.html:
	curl -fsSLo $@ $(URL)

cal.json: cal.html parse.ts
	deno run --allow-read parse.ts --base-url $(URL) $< > $@
