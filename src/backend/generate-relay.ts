import { api } from './common';

/**
 * `vsh_generate` protocol: injected scripts (e.g. Quill) running in the host
 * document cannot call `/api/v1/generate/raw` on a hosted Lumiverse instance
 * (the endpoint is localhost-only). This handler relays generation requests
 * through the Spindle worker's `spindle.generate.raw()` — which calls
 * `generateSvc.rawGenerate()` over IPC, bypassing the HTTP restriction.
 *
 * Frontend sends `{ type:'vsh_generate', requestId, ... }` via
 * `ctx.sendToBackend()`; we call `api.generate.raw()` and reply with
 * `vsh_generate_result` or `vsh_generate_error`.
 *
 * Requires the `generation` permission in spindle.json.
 */

interface GenerateRelayRequest {
  type: 'vsh_generate';
  requestId: string;
  messages: Array<{ role: string; content: string }>;
  provider?: string;
  model?: string;
  connection_id?: string;
  parameters?: {
    temperature?: number;
    max_tokens?: number;
    [key: string]: unknown;
  };
  tools?: unknown[];
  tool_choice?: unknown;
}

function isGenerateRelayRequest(p: unknown): p is GenerateRelayRequest {
  return (
    !!p &&
    typeof p === 'object' &&
    (p as { type?: unknown }).type === 'vsh_generate' &&
    typeof (p as { requestId?: unknown }).requestId === 'string' &&
    Array.isArray((p as { messages?: unknown }).messages)
  );
}

export function installGenerateRelayHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isGenerateRelayRequest(payload)) return;

    const { requestId, messages, provider, model, connection_id, parameters, tools, tool_choice } = payload;

    const input: Record<string, unknown> = {
      provider: provider || '',
      model: model || '',
      messages,
      userId,
    };
    if (connection_id) input.connection_id = connection_id;
    if (parameters) input.parameters = parameters;
    
    // Map OpenAI format -> Lumiverse ToolDefinition format
    if (tools && Array.isArray(tools)) {
      input.tools = tools.map((t: any) => {
        if (t?.type === 'function' && t?.function) {
          return {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
          };
        }
        return t; // Fallback
      });
    }
    
    // Lumiverse expects tool_choice inside parameters
    if (tool_choice) {
      if (!input.parameters) input.parameters = {};
      (input.parameters as Record<string, unknown>).tool_choice = tool_choice;
    }

    api.generate.raw(input).then(
      (result) => {
        api.sendToFrontend(
          { type: 'vsh_generate_result', requestId, result },
          userId,
        );
      },
      (err: unknown) => {
        api.sendToFrontend(
          {
            type: 'vsh_generate_error',
            requestId,
            error: err instanceof Error ? err.message : String(err),
          },
          userId,
        );
      },
    );
  });
}
