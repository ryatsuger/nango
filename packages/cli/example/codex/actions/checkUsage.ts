import { createAction } from 'nango';
import * as z from 'zod';

const action = createAction({
    description: `Get the connected ChatGPT account Codex usage, rate limits and credits`,
    version: '1.0.0',
    endpoint: { method: 'GET', path: '/codex/usage', group: 'Codex' },
    input: z.void(),
    output: z.object({
        plan_type: z.string().nullable().optional(),
        rate_limit: z.record(z.string(), z.unknown()).nullable().optional(),
        credits: z.record(z.string(), z.unknown()).nullable().optional(),
        spend_control: z.record(z.string(), z.unknown()).nullable().optional(),
        rate_limit_reached_type: z.string().nullable().optional()
    }),

    exec: async (nango) => {
        const res = await nango.get({ endpoint: '/wham/usage', baseUrlOverride: 'https://chatgpt.com/backend-api' });

        return res.data;
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
