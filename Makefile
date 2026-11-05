SHELL := /bin/bash
RECIPE ?= recipes/ct-anatomy.json
OUT    ?= out/anatomy
AT     ?= 0,1.5,3

.PHONY: setup preview render verify inventory assets clean

setup:            ## install node deps
	npm install

preview:          ## cheap contact sheet of three frames (agent feedback loop)
	node tools/capture.mjs --recipe $(RECIPE) --at $(AT) --out out/preview --contact-sheet

render:           ## full film: frames + manifest + contact sheet + mp4
	node tools/capture.mjs --recipe $(RECIPE) --out $(OUT) --contact-sheet --ffmpeg ffmpeg

verify:           ## determinism: two runs must be byte-identical
	node tools/verify.mjs --recipe $(RECIPE) --at $(AT)

inventory:        ## measure a GLB catalog (named parts per file)
	node tools/glb-inventory.mjs --repo codepawl/ct-anatomy-glb --sample 10

assets:           ## fetch + check assets against assets.manifest.json
	node tools/fetch-assets.mjs
	node tools/verify-assets.mjs

clean:
	rm -rf out
