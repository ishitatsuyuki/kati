test: metadata
test: source
	@echo $< $^

test2: source
	@echo $< $^
test2: metadata

metadata source:
	@touch $@
