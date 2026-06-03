import { createAction } from 'nango';
import * as z from 'zod';

const action = createAction({
    description: `Get the details of a single Codex cloud task by id`,
    version: '1.0.0',
    endpoint: { method: 'GET', path: '/codex/tasks/{taskId}', group: 'Codex' },
    input: z.object({
        taskId: z.string()
    }),
    output: z.object({
        current_user_turn: z.record(z.string(), z.unknown()).nullable().optional(),
        current_assistant_turn: z.record(z.string(), z.unknown()).nullable().optional(),
        current_diff_task_turn: z.record(z.string(), z.unknown()).nullable().optional()
    }),

    exec: async (nango, input) => {
        const res = await nango.get({
            endpoint: `/wham/tasks/${encodeURIComponent(input.taskId)}`,
            baseUrlOverride: 'https://chatgpt.com/backend-api'
        });

        return res.data;
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
