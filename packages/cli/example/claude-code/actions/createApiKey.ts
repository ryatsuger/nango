import { createAction } from 'nango';
import * as z from 'zod';

const action = createAction({
    description: `Mint an Anthropic API key from the connected Claude subscription (uses the org:create_api_key scope)`,
    version: '1.0.0',
    endpoint: { method: 'POST', path: '/claude-code/api-keys', group: 'Claude Code' },
    input: z.void(),
    output: z.record(z.string(), z.unknown()),

    exec: async (nango) => {
        const res = await nango.post({ endpoint: '/api/oauth/claude_cli/create_api_key', data: {} });

        return res.data;
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
