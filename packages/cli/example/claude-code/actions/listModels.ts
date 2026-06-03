import { createAction } from 'nango';
import * as z from 'zod';

const action = createAction({
    description: `List the Claude models available to the connected account`,
    version: '1.0.0',
    endpoint: { method: 'GET', path: '/claude-code/models', group: 'Claude Code' },
    input: z.void(),
    output: z.object({
        models: z.array(
            z.object({
                id: z.string(),
                display_name: z.string(),
                created_at: z.string()
            })
        )
    }),

    exec: async (nango) => {
        const res = await nango.get({ endpoint: '/v1/models' });
        const models = (res.data?.data ?? []) as { id: string; display_name: string; created_at: string }[];

        return {
            models: models.map((model) => ({
                id: model.id,
                display_name: model.display_name,
                created_at: model.created_at
            }))
        };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
