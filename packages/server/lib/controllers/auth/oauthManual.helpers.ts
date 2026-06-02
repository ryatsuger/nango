import * as crypto from 'node:crypto';

export function buildCodeChallenge(codeVerifier: string): string {
    return crypto.createHash('sha256').update(codeVerifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Anthropic's manual flow returns the value as `code#state`; users may also paste the full redirect URL.
export function parseAuthorizationResponse(input: string): { code: string; state?: string | undefined } {
    const trimmed = input.trim();

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const url = new URL(trimmed);
        const code = url.searchParams.get('code') ?? '';
        const state = url.searchParams.get('state');
        return state ? { code, state } : { code };
    }

    const hashIndex = trimmed.indexOf('#');
    if (hashIndex === -1) {
        return { code: decodeURIComponent(trimmed) };
    }

    return {
        code: decodeURIComponent(trimmed.slice(0, hashIndex)),
        state: decodeURIComponent(trimmed.slice(hashIndex + 1))
    };
}
