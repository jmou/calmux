URL = https://www.fortgreenepark.org/calendar

cal.html:
	curl -fsSLo $@ $(URL)

cal.json: cal.html parse.ts
	node parse.ts --base-url $(URL) $< > $@
