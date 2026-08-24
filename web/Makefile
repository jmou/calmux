_site/index.html: main.ts ../merge.json
	node $^ > $@

test:
	node --test

update-snapshots:
	node --test --test-update-snapshots

# TODO should ignore data directories
deploy:
	rsync -av --exclude node_modules . elmo:/opt/cal/
	ssh elmo sudo systemctl restart cal.service

serve:
	node server.ts

.PHONY: test update-snapshots deploy serve
