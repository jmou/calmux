_site/index.html: _params/merge.json main.ts template.html deno.json deno.lock
	deno run --allow-read=.. main.ts $< > $@

test:
	deno test --allow-read=.

update-snapshots:
	deno test --allow-read=. --allow-write=__snapshots__ -- --update

.PHONY: test update-snapshots
