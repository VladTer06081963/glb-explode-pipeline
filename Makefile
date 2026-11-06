SHELL := /bin/bash
RECIPE ?= recipes/ct-anatomy.json
OUT    ?= out/anatomy
AT     ?= 0,1.5,3
NAME   ?= ct-anatomy

.PHONY: setup preview render verify inventory assets deliver sound film clean

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

deliver:         ## hand the rendered film to the DaVinci Resolve stage (mp4, 24 fps, ~/Movies)
	node tools/capture.mjs --recipe $(RECIPE) --out $(OUT) --contact-sheet --ffmpeg ffmpeg
	bash tools/deliver-to-resolve.sh --film $(OUT)/film.mp4 --name $(NAME)

sound:            ## synthesise the assembly sound from the recipe (clack per bone)
	node tools/make-sound.mjs --recipe $(RECIPE) --out assets/$(NAME).wav

film: render sound ## render the film and mux the synthesised sound into it
	ffmpeg -v error -y -i $(OUT)/film.mp4 -i assets/$(NAME).wav \
	  -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 -shortest $(OUT)/film-sound.mp4
	@echo "-> $(OUT)/film-sound.mp4"

clean:
	rm -rf out
