# Changelog

## 2026-08-27
- Wired up SwitchYard request routing in model-router/.
- Added task-type-aware routing (routes.smart-v2), a custom 3-way classifier.

## 2026-08-25
- Moved AWS MCP Server wiring into its own mcp/ folder, separate from
  pi-multi-provider/.

## 2026-08-22
- Multi-provider Pi setup: Bedrock, NVIDIA NIM, local Ollama all reachable
  through the same --provider/--model interface.
