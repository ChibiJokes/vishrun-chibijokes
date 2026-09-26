import { installFetchExternalHandler } from './fetch-external';
import { installMacroResolveHandler } from './macro-resolve';
import { installMessageContentProcessor } from './message-content-processor';
import { installDispatchSlashHandler } from './dispatch-slash';
import { installThHelpersHandler } from './th-helpers';
import { installGenerateRelayHandler } from './generate-relay';
import { installPreGenerationBridgeHandler } from './pre-generation-bridge';
import { installUserMessageBridgeHandler } from './user-message-bridge';
import { api } from './common';

type NativeResourceName = 'personas' | 'world_books';

interface NativeResourceRequest {
  type: 'vsh_native_resource';
  requestId: string;
  resource: NativeResourceName;
  operation: string;
  args?: unknown[];
}

function isNativeResourceRequest(payload: unknown): payload is NativeResourceRequest {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Record<string, unknown>;
  return (
    value.type === 'vsh_native_resource' &&
    typeof value.requestId === 'string' &&
    (value.resource === 'personas' || value.resource === 'world_books') &&
    typeof value.operation === 'string' &&
    (value.args === undefined || Array.isArray(value.args))
  );
}

async function dispatchNativeResource(
  request: NativeResourceRequest,
  userId: string,
): Promise<unknown> {
  const args = Array.isArray(request.args) ? request.args : [];

  if (request.resource === 'personas') {
    switch (request.operation) {
      case 'list':
        return api.personas.list({ ...((args[0] as Record<string, unknown> | undefined) ?? {}), userId } as any);
      case 'get':
        return api.personas.get(String(args[0] ?? ''), userId);
      case 'getDefault':
        return api.personas.getDefault(userId);
      case 'getActive':
        return api.personas.getActive(userId);
      case 'create':
        return api.personas.create((args[0] ?? {}) as any, userId);
      case 'update':
        return api.personas.update(String(args[0] ?? ''), (args[1] ?? {}) as any, userId);
      case 'delete':
        return api.personas.delete(String(args[0] ?? ''), userId);
      case 'switchActive':
        return api.personas.switchActive(args[0] == null ? null : String(args[0]), userId);
      case 'getWorldBook':
        return api.personas.getWorldBook(String(args[0] ?? ''), userId);
      default:
        throw new Error(`Unsupported personas operation: ${request.operation}`);
    }
  }

  switch (request.operation) {
    case 'list':
      return api.world_books.list({ ...((args[0] as Record<string, unknown> | undefined) ?? {}), userId } as any);
    case 'get':
      return api.world_books.get(String(args[0] ?? ''), userId);
    case 'create':
      return api.world_books.create((args[0] ?? {}) as any, userId);
    case 'update':
      return api.world_books.update(String(args[0] ?? ''), (args[1] ?? {}) as any, userId);
    case 'delete':
      return api.world_books.delete(String(args[0] ?? ''), userId);
    case 'getActivated':
      return api.world_books.getActivated(String(args[0] ?? ''), userId);
    case 'getGlobal':
      return api.world_books.getGlobal(userId);
    case 'setGlobal':
      return api.world_books.setGlobal(Array.isArray(args[0]) ? args[0].map(String) : [], userId);
    case 'activateGlobal':
      return api.world_books.activateGlobal(String(args[0] ?? ''), userId);
    case 'deactivateGlobal':
      return api.world_books.deactivateGlobal(String(args[0] ?? ''), userId);
    case 'entries.list':
      return api.world_books.entries.list(
        String(args[0] ?? ''),
        { ...((args[1] as Record<string, unknown> | undefined) ?? {}), userId } as any,
      );
    case 'entries.get':
      return api.world_books.entries.get(String(args[0] ?? ''), userId);
    case 'entries.create':
      return api.world_books.entries.create(String(args[0] ?? ''), (args[1] ?? {}) as any, userId);
    case 'entries.update':
      return api.world_books.entries.update(String(args[0] ?? ''), (args[1] ?? {}) as any, userId);
    case 'entries.delete':
      return api.world_books.entries.delete(String(args[0] ?? ''), userId);
    default:
      throw new Error(`Unsupported world_books operation: ${request.operation}`);
  }
}

function installNativeResourceBridge(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isNativeResourceRequest(payload)) return;

    void dispatchNativeResource(payload, userId).then(
      (result) => {
        api.sendToFrontend(
          { type: 'vsh_native_resource_result', requestId: payload.requestId, result },
          userId,
        );
      },
      (error: unknown) => {
        api.sendToFrontend(
          {
            type: 'vsh_native_resource_error',
            requestId: payload.requestId,
            error: error instanceof Error ? error.message : String(error),
          },
          userId,
        );
      },
    );
  });
}

/**
 * Backend worker module. Vishrun is logically frontend-only, but the worker
 * must exist: its mere existence keeps the host's sandbox `corsProxy` bridge
 * alive, and it serves the frontend's backend-only needs — `fetch_external`
 * (CDN asset downloads via `spindle.cors`), `resolve_macros` (widget HTML
 * through `spindle.macros.resolve`), and the `/setvar` message content
 * processor. The host loads this with a bare `import()` and exposes the API as
 * `globalThis.spindle` first — no `setup(api)` callback — so registration runs
 * at module top level here; `setup()` stays as a no-op for the prior convention.
 */

installFetchExternalHandler();
installMacroResolveHandler();
installMessageContentProcessor();
installDispatchSlashHandler();
installThHelpersHandler();
installGenerateRelayHandler();
installPreGenerationBridgeHandler();
installUserMessageBridgeHandler();
installNativeResourceBridge();

export function setup(): void {
  // intentionally empty — registration happens at module top level (above).
}
