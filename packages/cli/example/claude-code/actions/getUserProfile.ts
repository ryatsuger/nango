import { createAction } from 'nango';
import * as z from 'zod';

const action = createAction({
    description: `Get the connected Claude account and organization profile`,
    version: '1.0.0',
    endpoint: { method: 'GET', path: '/claude-code/profile', group: 'Claude Code' },
    input: z.void(),
    output: z.object({
        account: z.object({
            uuid: z.string(),
            email: z.string(),
            full_name: z.string().nullable().optional(),
            display_name: z.string().nullable().optional(),
            has_claude_max: z.boolean().optional(),
            has_claude_pro: z.boolean().optional()
        }),
        organization: z.object({
            uuid: z.string(),
            name: z.string(),
            organization_type: z.string().nullable().optional(),
            rate_limit_tier: z.string().nullable().optional(),
            subscription_status: z.string().nullable().optional()
        }),
        application: z
            .object({
                uuid: z.string(),
                name: z.string(),
                slug: z.string()
            })
            .optional()
    }),

    exec: async (nango) => {
        const res = await nango.get({ endpoint: '/api/oauth/profile' });

        return res.data;
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
