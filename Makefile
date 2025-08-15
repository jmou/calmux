all: web/_site/index.html

merge.json: asp/asp.json ftgreene-park/cal.json
	jq -s '{name: [.[].name] | join(" + "), events: map(.events[])}' $^ > $@

asp/asp.json:
	$(MAKE) -C asp asp.json

ftgreene-park/cal.json:
	$(MAKE) -C ftgreene-park cal.json

web/_site/index.html: merge.json
	$(MAKE) -C web _site/index.html

.PHONY: all
