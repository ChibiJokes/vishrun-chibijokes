import { api } from './common';

export function installGenerateRelayHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { type?: string; requestId?: string };
    if (p.type !== 'vsh_generate') return;
    
    const { requestId, messages, provider, model, connection_id, parameters } = 
      payload as any;
    
    api.generate({
      type: 'raw',
      provider, model, connection_id, messages,
      parameters: parameters || {},
      userId,
    }).then(result => {
      api.sendToFrontend({ 
        type: 'vsh_generate_result', requestId, result 
      }, userId);
    }).catch(err => {
      api.sendToFrontend({ 
        type: 'vsh_generate_error', requestId, 
        error: err instanceof Error ? err.message : String(err) 
      }, userId);
    });
  });
}
