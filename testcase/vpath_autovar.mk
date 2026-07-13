VPATH := source

test: output

output: input
	@echo $<

input:
	@mkdir -p source
	@touch source/input
