// Auto-disables tools while the switchyard/vision model is active, and
// restores them on switching away. Selecting "vision" via /model or Ctrl+P
// otherwise reproduces the same upstream vLLM/mllama bug --no-tools works
// around on the CLI: NVIDIA's Llama-3.2-Vision backend miscounts image
// placeholder tokens once pi's tool-schema system prompt is in the request.
// See model-router/tests/README.md for the full story.
const VISION_ROUTE_IDS = new Set(["vision"]);

function isVisionModel(model) {
  return model?.provider === "switchyard" && VISION_ROUTE_IDS.has(model.id);
}

export default function (pi) {
  let savedTools = null;

  pi.on("model_select", async (event, ctx) => {
    const enteringVision = isVisionModel(event.model);
    const leavingVision = isVisionModel(event.previousModel);

    if (enteringVision && !leavingVision) {
      savedTools = pi.getActiveTools();
      pi.setActiveTools([]);
      ctx.ui.notify(
        "Tools disabled for switchyard/vision — NVIDIA's Llama-3.2-Vision backend miscounts image tokens against pi's tool-schema prompt. Switch models to restore tools.",
        "info",
      );
    } else if (!enteringVision && leavingVision && savedTools) {
      pi.setActiveTools(savedTools);
      savedTools = null;
    }
  });
}
