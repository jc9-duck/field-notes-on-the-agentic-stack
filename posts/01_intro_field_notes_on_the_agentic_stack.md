# Field Notes on the Agentic Stack
## Post 1: Intro (v2)

I've been busier than I've been in years, and building more than I have in years. Those two aren't supposed to go together, but here we are, and I'm having a blast.

Work has had me deep in agent tooling. I've also been diving into it on my own time, mostly because I can't help myself. Somewhere in there I realized I had enough scattered notes and half-finished experiments to actually be useful to other people, if I bothered to write them down.

So I'm starting a series: Field Notes on the Agentic Stack. No promises on frequency. Some weeks I'll post twice, some weeks not at all. What I will keep consistent is the thread: practical, tangible stuff for people actually building with agents, not theory.

Here's roughly what's coming. Pi as an agent harness. Model agnostic systems instead of marrying one vendor. Picking the right model for the task. Running agents across terminals, including how one orchestrator session can actually manage several others instead of you switching between five tabs yourself. And eventually MCP, not the servers everyone's already covered, but the gateway layer: observability, policy enforcement, keeping this from turning into shadow IT with extra steps.

First up, a peek at Pi. Say you want an agentic coding tool that can talk to any model backend: Anthropic, OpenAI, Nemotron, GLM, hosted locally or through a provider like NVIDIA's inference hub or AWS Bedrock. You can bend Claude Code or Codex toward other models, but it's not native, and in my experience it's clunky. Cursor gets you closer, but it's still Cursor's world. Pi is different, purpose-built for real model agnosticism, not a workaround. The tradeoff: using Pi is less like buying a Millennium Falcon toy and more like buying the thousand piece Lego version. Slower to build, less polished out of the box, but you built it, and you can swap pieces whenever you want.

I'll be sharing code where I can. Everything here is open source, including some tooling from NVIDIA I've been working with. To be clear, this isn't an NVIDIA blog and I don't speak for them. This is just what I'm learning as one practitioner poking around in public.

What's the one tool outside your usual stack you've been meaning to try? Tell me, and I might just cover it.

#AI #AgentEngineering #OpenSource #MCP #AgenticStack
