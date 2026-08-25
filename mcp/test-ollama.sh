#!/bin/bash
docker compose run --rm pi bash -lc "pi -e /work/pi-extensions/ollama-provider.mjs --provider ollama  --model llama3.2:1b -p 'say hello in exactly 3 words'"
