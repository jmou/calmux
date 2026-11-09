_site/index.html: _params/merge.json main.ts template.html
	node main.ts --from 2025-01-01 --to 2025-12-31 $< > $@

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
