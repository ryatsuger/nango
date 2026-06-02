import { afterEach, describe, expect, it, vi } from 'vitest';

import { axiosInstance } from '@nangohq/utils';

import providerClientManager from './provider.client.js';

import type { Config as ProviderConfig } from '../models/index.js';
import type { DBConnectionDecrypted, ProviderOAuth2 } from '@nangohq/types';

function mockTokenResponse() {
    return vi.spyOn(axiosInstance, 'post').mockResolvedValue({ status: 200, data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } });
}

describe('ProviderClient claude-code', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('routes claude-code through the provider client', () => {
        expect(providerClientManager.shouldUseProviderClient('claude-code')).toBe(true);
    });

    it('getToken sends client_id and code_verifier but never client_secret', async () => {
        const spy = mockTokenResponse();
        const config = {
            provider: 'claude-code',
            oauth_client_id: 'public-id',
            oauth_client_secret: 'should-not-be-sent'
        } as unknown as ProviderConfig;

        await providerClientManager.getToken(
            config,
            'https://console.anthropic.com/v1/oauth/token',
            'the-code',
            'https://console.anthropic.com/oauth/code/callback',
            'the-verifier',
            { oauth_state: 'state-123' }
        );

        expect(spy).toHaveBeenCalledOnce();
        const body = spy.mock.calls[0]![1] as Record<string, unknown>;
        expect(body['client_id']).toBe('public-id');
        expect(body['code']).toBe('the-code');
        expect(body['code_verifier']).toBe('the-verifier');
        expect(body['grant_type']).toBe('authorization_code');
        expect(body['redirect_uri']).toBe('https://console.anthropic.com/oauth/code/callback');
        expect(body['state']).toBe('state-123');
        expect(body).not.toHaveProperty('client_secret');
    });

    it('refreshToken sends client_id and refresh_token but never client_secret', async () => {
        const spy = mockTokenResponse();
        const config = {
            provider: 'claude-code',
            oauth_client_id: 'public-id',
            oauth_client_secret: 'should-not-be-sent'
        } as unknown as ProviderConfig;
        const provider = {
            auth_mode: 'OAUTH2_MANUAL',
            token_url: 'https://console.anthropic.com/v1/oauth/token'
        } as unknown as ProviderOAuth2;
        const connection = {
            connection_config: {},
            credentials: { type: 'OAUTH2', access_token: 'old-at', refresh_token: 'old-rt' }
        } as unknown as DBConnectionDecrypted;

        await providerClientManager.refreshToken(provider, config, connection);

        expect(spy).toHaveBeenCalledOnce();
        const body = spy.mock.calls[0]![1] as Record<string, unknown>;
        expect(body['client_id']).toBe('public-id');
        expect(body['refresh_token']).toBe('old-rt');
        expect(body['grant_type']).toBe('refresh_token');
        expect(body).not.toHaveProperty('client_secret');
    });
});
