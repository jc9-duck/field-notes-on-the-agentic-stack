# Field Notes on the Agentic Stack
## Post 4: Bringing your own model

My last post showed native Pi providers, Amazon Bedrock and NVIDIA's inference hub. Today: a provider Pi has never heard of. My own laptop.

For this demo I'm using Ollama, running llama3.2:1b, on a Mac, in Docker. Nothing heavy needed, I'm on an older M2 with an external SSD, and this is plenty for a demo. If you don't have Ollama yet, details in the comments.

One catch worth flagging: Ollama runs natively on my Mac, not inside Docker. Docker Desktop on Apple Silicon can't pass GPU acceleration into a container, so a containerized model server would be CPU only. Only Pi lives in the container. Ollama stays on the host to keep its speed.

Once installed, confirm it's working: curl http://localhost:11434/api/generate -d '{"model": "llama3.2:1b", "prompt": "say hi", "stream": false}'

Now tell Pi about it. Since Pi runs in Docker, we persist this the way we've persisted everything else, bake it into the image.

First, a small extension file using Pi's pi.registerProvider() API: an endpoint URL, Ollama exposes an OpenAI-compatible API at /v1, a request format, and available models. Instead of hardcoding a model name, the file fetches Ollama's model list live on every startup, so whatever you've pulled locally just shows up.

Then we update settings.json to load that extension automatically, one line telling Pi to run this file on startup. The settings file itself is always named settings.json, Pi looks for it by that name. What you name the extension file it points to is entirely up to you.

Pi has zero built-in awareness of Ollama, this is the one place we explicitly tell it where to look. One networking detail: since Pi runs in a container but Ollama runs on the Mac itself, the extension points at host.docker.internal instead of localhost, Docker Desktop's DNS name for reaching the host from inside a container.

Rebuild the container, launch Pi, and select the model, same --provider and --model flags as Bedrock or NVIDIA.

Mac, Docker, and Ollama are just my setup for this demo. The concept generalizes: any self-hosted inference endpoint, a Linux box on your network, a model server at the office, works the same way. Give Pi a URL and a model list, and it doesn't care where that endpoint actually lives.

Bedrock, NVIDIA, and a laptop sitting next to me are, architecturally, the exact same thing to Pi.

I'd genuinely encourage you to follow along on this one. I broke down every piece, the model, the container caveat, the extension, the networking, specifically so you're not left stitching together five different docs pages the way I was. That's the whole point of doing this in public.

If you build it, tell me what you pointed it at. What's on your network that you'd want an agent to reach, if it were this easy?

#AI #AgentEngineering #OpenSource #AgenticStack #DevTools
