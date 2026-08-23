_site/index.html: main.ts ../merge.json
	deno run --allow-read=.. $^ > $@

test:
	deno test --allow-read=. --allow-write=. --allow-net

update-snapshots:
	deno test --allow-read=. --allow-write=. -- --update

# TODO should ignore data directories
deploy:
	rsync -av . elmo:/opt/cal/
	ssh elmo sudo systemctl restart cal.service

serve:
	deno run --allow-net=0.0.0.0:8000 --allow-read=. --allow-write=events,_site server.ts

.PHONY: test update-snapshots deploy serve
