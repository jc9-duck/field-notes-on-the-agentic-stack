# Field Notes on the Agentic Stack
## Post 2: A quick history of coding agents

I used to think ChatGPT started the coding agent era. Turns out GitHub Copilot beat it to general availability by five months. Memory is a strange editor.

Here's my actual path, corrected against the real timeline.

Copilot went generally available in June 2022, quietly, inside the IDE, autocomplete on steroids. AWS previewed CodeWhisperer that same month. Neither made me sit up. Then ChatGPT launched that November, and that's the moment it landed for me. Type a prompt, get code back. Mind blowing at the time, painful in hindsight: tiny context window, shaky code quality, generation that died mid output, constant copy-paste between a chat window and VS Code.

I stitched that chat experience into the IDE with one of the early, unofficial ChatGPT extensions built on the OpenAI API. Kludgey is generous, but it worked.

Copilot kept maturing into something more native. Still traditional coding though, I'm opening files, editing, reviewing. More like pair programming with a fast, occasionally wrong partner.

Cursor, launched in 2023, perfected that model for me. It forked VS Code but built AI in from the ground up instead of bolting it on. To me, that was the pinnacle of the IDE centered approach.

Then Anthropic shipped Claude Code in February 2025, and it broke the model entirely. You're not looking at files anymore. You're structuring prompts, writing skills, feeding requirements and test criteria, and letting the agent go do the work. The first time I opened it, before real time in Cursor, it felt daunting. After Cursor, coming back to Claude Code, it clicked.

Others followed. OpenAI shipped Codex CLI in April 2025. Cursor launched its own CLI agent in August 2025. None are technically locked to one model family, you can point most elsewhere. In my experience, that's true on paper more than practice. Claude Code feels tuned for Anthropic's models, Codex for OpenAI's. Cursor is the exception, real multi-model support for a while now, including a jointly trained Grok model via its xAI partnership.

That's what pushed me toward Pi, a genuinely open source, model agnostic tool. Not the only one out there, but the one I've spent the most time in. Load models from multiple providers, mix and match, and there are early tools for automatically routing a task to whichever model handles it best. More on that later.

Same tradeoff I opened this series with. Claude Code is the Millennium Falcon toy, polished, ready to fly. Pi is the thousand piece Lego version, you assemble it yourself, and it's not as slick out of the box.

What you get in exchange is real choice. Nothing in Pi is hard coded to one model, so you pull in whatever works best for you. Community packages exist, and you can build your own. Since Pi talks to AI, you can use AI to build the package you need.

Where did your path actually start? Copilot, ChatGPT, Cursor, something else? Curious how many of us remember the order right.

#AI #AgentEngineering #CodingAgents #OpenSource #AgenticStack
