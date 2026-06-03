import { createAction } from 'nango';
import * as z from 'zod';

const action = createAction({
    description: `List the Codex models available to the connected ChatGPT account`,
    version: '1.0.0',
    endpoint: { method: 'GET', path: '/codex/models', group: 'Codex' },
    input: z.void(),
    output: z.object({
        models: z.array(
            z.object({
                slug: z.string(),
                display_name: z.string(),
                description: z.string().nullable().optional(),
                supported_in_api: z.boolean().optional(),
                context_window: z.number().nullable().optional()
            })
        )
    }),

    exec: async (nango) => {
        // The Codex /models endpoint returns 400 unless a client_version query param is supplied; this tracks the latest codex CLI release.
        const res = await nango.get({ endpoint: '/models', params: { client_version: '0.136.0' } });
        const models = (res.data?.models ?? []) as {
            slug: string;
            display_name: string;
            description?: string | null;
            supported_in_api?: boolean;
            context_window?: number | null;
        }[];

        return {
            models: models.map((model) => ({
                slug: model.slug,
                display_name: model.display_name,
                description: model.description ?? null,
                supported_in_api: model.supported_in_api,
                context_window: model.context_window ?? null
            }))
        };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
