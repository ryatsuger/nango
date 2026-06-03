import { createAction } from 'nango';
import * as z from 'zod';

const usageWindow = z.object({
    utilization: z.number(),
    resets_at: z.string().nullable()
});

const action = createAction({
    description: `Get the connected account rolling-window usage / quota`,
    version: '1.0.0',
    endpoint: { method: 'GET', path: '/claude-code/usage', group: 'Claude Code' },
    input: z.void(),
    output: z.object({
        five_hour: usageWindow.nullable().optional(),
        seven_day: usageWindow.nullable().optional(),
        seven_day_opus: usageWindow.nullable().optional(),
        seven_day_sonnet: usageWindow.nullable().optional()
    }),

    exec: async (nango) => {
        const res = await nango.get({ endpoint: '/api/oauth/usage' });

        return res.data;
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
