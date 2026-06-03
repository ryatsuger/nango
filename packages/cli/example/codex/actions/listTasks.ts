import { createAction } from 'nango';
import * as z from 'zod';

const action = createAction({
    description: `List the connected ChatGPT account Codex cloud tasks`,
    version: '1.0.0',
    endpoint: { method: 'GET', path: '/codex/tasks', group: 'Codex' },
    input: z.object({
        limit: z.number().optional(),
        cursor: z.string().optional()
    }),
    output: z.object({
        items: z.array(z.record(z.string(), z.unknown())),
        cursor: z.string().nullable().optional()
    }),

    exec: async (nango, input) => {
        const params: Record<string, string | number> = {};
        if (input.limit !== undefined) {
            params['limit'] = input.limit;
        }
        if (input.cursor !== undefined) {
            params['cursor'] = input.cursor;
        }

        const res = await nango.get({ endpoint: '/wham/tasks/list', baseUrlOverride: 'https://chatgpt.com/backend-api', params });
        const data = res.data as { items?: Record<string, unknown>[]; cursor?: string | null };

        return {
            items: data.items ?? [],
            cursor: data.cursor ?? null
        };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
