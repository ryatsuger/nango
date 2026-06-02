import { describe, expect, it } from 'vitest';

import { buildCodeChallenge, parseAuthorizationResponse } from './oauthManual.helpers.js';

describe('parseAuthorizationResponse', () => {
    it('parses a code#state value', () => {
        expect(parseAuthorizationResponse('the-code#the-state')).toEqual({ code: 'the-code', state: 'the-state' });
    });

    it('url-decodes both parts', () => {
        expect(parseAuthorizationResponse('a%2Bb#s%2Ft')).toEqual({ code: 'a+b', state: 's/t' });
    });

    it('parses a bare code without state', () => {
        expect(parseAuthorizationResponse('only-code')).toEqual({ code: 'only-code' });
    });

    it('parses a full redirect URL with code and state', () => {
        expect(parseAuthorizationResponse('https://console.anthropic.com/oauth/code/callback?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    });

    it('trims surrounding whitespace', () => {
        expect(parseAuthorizationResponse('  c#s  ')).toEqual({ code: 'c', state: 's' });
    });
});

describe('buildCodeChallenge', () => {
    it('produces a url-safe base64 S256 challenge without padding', () => {
        const challenge = buildCodeChallenge('a-verifier');
        expect(challenge).not.toMatch(/[+/=]/);
        expect(challenge).toBe(buildCodeChallenge('a-verifier'));
        expect(challenge).not.toBe(buildCodeChallenge('different-verifier'));
    });
});
