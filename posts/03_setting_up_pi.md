# Field Notes on the Agentic Stack
## Post 3: Setting up Pi

Sign into Claude Code and you get models and tools ready to go. Sign into Pi for the first time and you get almost nothing. That's not a bug, it's the whole design.

Pi ships with a small, fixed set of built-in tools, read, write, edit, bash, plus a few for search, instead of the long list of slash commands you'd get elsewhere. First launch feels anticlimactic. Remember, we didn't buy the Millennium Falcon toy. We bought the thousand piece Lego kit, and now we're building it.

Before you install anything, a word of caution. Many coding agents put some kind of guardrail between themselves and your machine, permission prompts, workspace sandboxing, native OS controls, the specifics vary by tool. Pi doesn't. By its own docs, it runs with the full permissions of whatever launched it. That's not an oversight, it's by design.

My recommendation: don't run it bare. Use a container. Pi's own docs point to a few options here, including Gondolin and OpenShell, NVIDIA's policy-controlled sandbox, worth its own post later in this series. For now, we're standing up a simple Docker container, since MCP servers and an agent gateway are both coming later and I want one consistent foundation to build on as this series goes.

Next you'll need an API key, and you're not limited to just one. NVIDIA offers a free tier to get started, link in the comments. Anthropic, OpenAI, AWS Bedrock, a local model, any inference endpoint works, wire up two or three if you want. This is the model agnostic part in practice: Pi isn't married to one provider, and later in this series we'll get into dynamically routing between models based on the task.

Once you're connected, you're in business. But you'll quickly want more: subagents, web access, an MCP adapter. You can install these directly in Pi: pi install npm:pi-mcp-adapter, pi install npm:pi-web-access, pi install npm:pi-subagents. If you're running in Docker, install them and also bake them into your Dockerfile, or your next container launch starts back at zero.

Some extensions you'll actually need, like the three above. Others are just fun. Look up pi-powerline-footer if you want a persistent status line, model, git branch, context usage, cost, all visible at a glance, similar in spirit to Claude Code's status line. Not required, but kinda neat.

If you've made it this far, you have a minimum viable Pi setup, actually functioning. Try prompting it: search the web and summarize the latest headlines, or write a simple Python script to do X, or even review my Pi config and suggest how to configure it further. Odds are it gives you a solid suggestion, and if you like it, it'll implement it too.

One more reminder: if you like what you've built, save it to your Dockerfile so it's there the next time you launch.

I encourage you to actually do this. Total cost: zero dollars. What's stopping you?

#AI #AgentEngineering #OpenSource #AgenticStack #DevTools
