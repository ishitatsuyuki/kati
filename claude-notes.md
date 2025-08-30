* Have a guideline for enum usage
* Project order: data classes -> utils -> expr parser -> stmt parser -> directives -> main -> test loop
* Write something first, rewrite idioms later
* Put a TODO for unimplemented items, and emit a warning if an unimplemented code path is triggered
* Always make a list of things to implement
* Logger should come first

TODO:
* Line number is wrong
* Literal init is a mess

trickiness
* variable scopes
* var dep tracking
* no more symbols / interns