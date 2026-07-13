FLAGS := global

test: FLAGS := $(FLAGS) target
test:
	@echo $(FLAGS)
