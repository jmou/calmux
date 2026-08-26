_site/index.html: main.ts ../merge.json
	node $^ > $@

test:
	node --test

update-snapshots:
	node --test --test-update-snapshots

deploy:
	rsync -av --del --exclude _site . elmo:/opt/cal/
	ssh elmo sudo systemctl restart cal.service

serve:
	node server.ts

.PHONY: test update-snapshots deploy serve
