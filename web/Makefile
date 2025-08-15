_site/index.html: main.ts ../merge.json
	deno run --allow-read=.. $^ > $@

test:
	deno test --allow-read=.

update-snapshots:
	deno test --allow-read=. --allow-write=__snapshots__ -- --update

.PHONY: test update-snapshots
