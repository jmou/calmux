all: web/_site/index.html

merge.json: asp/asp.json ftgreene-park/cal.json
	jq -s '{name: [.[].name] | join(" + "), events: map(.events[])}' $^ > $@

asp/asp.json:
	$(MAKE) -C asp asp.json

ftgreene-park/cal.json: node_modules
	$(MAKE) -C ftgreene-park cal.json

web/_site/index.html: merge.json
	$(MAKE) -C web _site/index.html

node_modules: package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch $@

.PHONY: all
