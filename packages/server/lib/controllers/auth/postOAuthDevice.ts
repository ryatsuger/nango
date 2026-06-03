import * as uuid from 'uuid';
import * as z from 'zod';

import db from '@nangohq/database';
import { defaultOperationExpiration, endUserToMeta, logContextGetter } from '@nangohq/logs';
import {
    ErrorSourceEnum,
    LogActionEnum,
    configService,
    connectionService,
    errorManager,
    getConnectionConfig,
    getConnectionMetadata,
    getProvider,
    makeUrl,
    providerClientManager,
    syncEndUserToConnection
} from '@nangohq/shared';
import { axiosInstance as axios, metrics, stringifyError, zodErrorToHTTP } from '@nangohq/utils';

import { connectionCredential, connectionIdSchema, providerConfigKeySchema } from '../../helpers/validation.js';
import { validateConnection } from '../../hooks/connection/on/validate-connection.js';
import { connectionCreated as connectionCreatedHook, connectionCreationFailed as connectionCreationFailedHook } from '../../hooks/hooks.js';
import oAuthSessionService from '../../services/oauth-session.service.js';
import { asyncWrapper } from '../../utils/asyncWrapper.js';
import { errorRestrictConnectionId, isIntegrationAllowed } from '../../utils/auth.js';
import { hmacCheck } from '../../utils/hmac.js';

import type { LogContext } from '@nangohq/logs';
import type { Config as ProviderConfig } from '@nangohq/shared';
import type { OAuth2Credentials, PostPublicOAuthDevicePoll, PostPublicOAuthDeviceStart, ProviderOAuth2, ProviderOAuth2DeviceCode } from '@nangohq/types';

const DEVICE_AUTH_ID_KEY = 'oauth_device_auth_id';
const USER_CODE_KEY = 'oauth_device_user_code';

const paramValidation = z
    .object({
        providerConfigKey: providerConfigKeySchema
    })
    .strict();

const startQueryValidation = z
    .object({
        connection_id: connectionIdSchema.optional(),
        params: z.record(z.string(), z.any()).optional()
    })
    .and(connectionCredential);

const pollBodyValidation = z
    .object({
        state: z.string().min(1)
    })
    .strict();

const pollQueryValidation = z.object({}).and(connectionCredential);

export const postPublicOAuthDeviceStart = asyncWrapper<PostPublicOAuthDeviceStart>(async (req, res, next) => {
    const queryVal = startQueryValidation.safeParse(req.query);
    if (!queryVal.success) {
        res.status(400).send({ error: { code: 'invalid_query_params', errors: zodErrorToHTTP(queryVal.error) } });
        return;
    }

    const paramVal = paramValidation.safeParse(req.params);
    if (!paramVal.success) {
        res.status(400).send({ error: { code: 'invalid_uri_params', errors: zodErrorToHTTP(paramVal.error) } });
        return;
    }

    const { account, environment, connectSession } = res.locals;
    const queryString = queryVal.data;
    const { providerConfigKey } = paramVal.data;
    const connectionConfig = queryString.params ? getConnectionConfig(queryString.params) : {};
    let connectionId = queryString.connection_id || connectionService.generateConnectionId();
    const hmac = 'hmac' in queryString ? queryString.hmac : undefined;
    const isConnectSession = res.locals['authType'] === 'connectSession';

    if (isConnectSession && queryString.connection_id) {
        errorRestrictConnectionId(res);
        return;
    }

    let logCtx: LogContext | undefined;
    let config: ProviderConfig | null = null;

    try {
        logCtx =
            isConnectSession && connectSession.operationId
                ? logContextGetter.get({ id: connectSession.operationId, accountId: account.id })
                : await logContextGetter.create(
                      {
                          operation: { type: 'auth', action: 'create_connection' },
                          meta: { authType: 'oauth2_device_code', connectSession: endUserToMeta(res.locals.endUser) },
                          expiresAt: defaultOperationExpiration.auth()
                      },
                      { account, environment }
                  );

        if (!isConnectSession) {
            const checked = await hmacCheck({ environment, logCtx, providerConfigKey, connectionId, hmac, res });
            if (!checked) {
                return;
            }
        }

        config = await configService.getProviderConfig(providerConfigKey, environment.id);
        if (!config) {
            void logCtx.error('Unknown provider config');
            await logCtx.failed();
            res.status(404).send({ error: { code: 'unknown_provider_config' } });
            return;
        }

        const provider = getProvider(config.provider);
        if (!provider) {
            void logCtx.error('Unknown provider');
            await logCtx.failed();
            res.status(404).send({ error: { code: 'unknown_provider_template' } });
            return;
        }

        if (provider.auth_mode !== 'OAUTH2_DEVICE_CODE') {
            void logCtx.error('Provider does not support device code OAuth', { provider: config.provider });
            await logCtx.failed();
            res.status(400).send({ error: { code: 'invalid_auth_mode' } });
            return;
        }

        if (!(await isIntegrationAllowed({ config, res, logCtx }))) {
            return;
        }

        if (isConnectSession && connectSession.connectionId) {
            const connection = await connectionService.getConnectionById(connectSession.connectionId);
            if (!connection) {
                void logCtx.error('Invalid connection');
                await logCtx.failed();
                res.status(400).send({ error: { code: 'invalid_connection' } });
                return;
            }
            connectionId = connection.connection_id;
        }

        const deviceProvider = provider as ProviderOAuth2DeviceCode;
        const state = uuid.v4();

        const deviceAuthUrl = makeUrl(deviceProvider.device_authorization_url, connectionConfig).href;

        const deviceResponse = await axios.post(deviceAuthUrl, { client_id: config.oauth_client_id }, { headers: { 'Content-Type': 'application/json' } });

        const deviceAuthId = deviceResponse.data?.['device_auth_id'];
        const userCode = deviceResponse.data?.['user_code'];
        const interval = Number(deviceResponse.data?.['interval']) || 5;

        if (!deviceAuthId || !userCode) {
            void logCtx.error('Device authorization request did not return a user code');
            await logCtx.failed();
            res.status(400).send({ error: { code: 'invalid_auth_mode', message: 'Device authorization failed' } });
            return;
        }

        await oAuthSessionService.create({
            id: state,
            providerConfigKey,
            provider: config.provider,
            connectionId,
            callbackUrl: deviceProvider.redirect_uri,
            authMode: 'OAUTH2_DEVICE_CODE',
            connectSessionId: isConnectSession ? connectSession.id : null,
            connectionConfig: { ...connectionConfig, [DEVICE_AUTH_ID_KEY]: deviceAuthId, [USER_CODE_KEY]: userCode },
            environmentId: environment.id,
            webSocketClientId: undefined,
            activityLogId: logCtx.id,
            codeVerifier: null,
            requestTokenSecret: null,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        void logCtx.info('Device code OAuth authorization started', { providerConfigKey, connectionId, provider: config.provider });

        res.status(200).send({ userCode, verificationUri: deviceProvider.verification_uri, interval, state, connectionId });
    } catch (err) {
        if (logCtx) {
            void logCtx.error('Error during device code OAuth start', { error: err });
            await logCtx.failed();
        }

        errorManager.report(err, {
            source: ErrorSourceEnum.PLATFORM,
            operation: LogActionEnum.AUTH,
            environmentId: environment.id,
            metadata: { providerConfigKey, connectionId }
        });

        metrics.increment(metrics.Types.AUTH_FAILURE, 1, { auth_mode: 'OAUTH2_DEVICE_CODE', ...(config ? { provider: config.provider } : {}) });

        next(err);
    }
});

export const postPublicOAuthDevicePoll = asyncWrapper<PostPublicOAuthDevicePoll>(async (req, res, next) => {
    const bodyVal = pollBodyValidation.safeParse(req.body);
    if (!bodyVal.success) {
        res.status(400).send({ error: { code: 'invalid_body', errors: zodErrorToHTTP(bodyVal.error) } });
        return;
    }

    const queryVal = pollQueryValidation.safeParse(req.query);
    if (!queryVal.success) {
        res.status(400).send({ error: { code: 'invalid_query_params', errors: zodErrorToHTTP(queryVal.error) } });
        return;
    }

    const paramVal = paramValidation.safeParse(req.params);
    if (!paramVal.success) {
        res.status(400).send({ error: { code: 'invalid_uri_params', errors: zodErrorToHTTP(paramVal.error) } });
        return;
    }

    const { account, environment, connectSession } = res.locals;
    const { state } = bodyVal.data;
    const { providerConfigKey } = paramVal.data;
    const isConnectSession = res.locals['authType'] === 'connectSession';

    let logCtx: LogContext | undefined;
    let config: ProviderConfig | null = null;
    let connectionId = '';

    try {
        const oauthSession = await oAuthSessionService.findById(state);
        if (!oauthSession || oauthSession.providerConfigKey !== providerConfigKey || oauthSession.authMode !== 'OAUTH2_DEVICE_CODE') {
            res.status(400).send({ error: { code: 'invalid_state', message: 'Authorization session not found or expired' } });
            return;
        }

        connectionId = oauthSession.connectionId;

        logCtx =
            isConnectSession && connectSession.operationId
                ? logContextGetter.get({ id: connectSession.operationId, accountId: account.id })
                : await logContextGetter.create(
                      {
                          operation: { type: 'auth', action: 'create_connection' },
                          meta: { authType: 'oauth2_device_code', connectSession: endUserToMeta(res.locals.endUser) },
                          expiresAt: defaultOperationExpiration.auth()
                      },
                      { account, environment }
                  );

        config = await configService.getProviderConfig(providerConfigKey, environment.id);
        if (!config) {
            void logCtx.error('Unknown provider config');
            await logCtx.failed();
            res.status(404).send({ error: { code: 'unknown_provider_config' } });
            return;
        }

        const provider = getProvider(config.provider);
        if (!provider || provider.auth_mode !== 'OAUTH2_DEVICE_CODE') {
            void logCtx.error('Provider does not support device code OAuth');
            await logCtx.failed();
            res.status(400).send({ error: { code: 'invalid_auth_mode' } });
            return;
        }

        if (!(await isIntegrationAllowed({ config, res, logCtx }))) {
            return;
        }

        const deviceProvider = provider as ProviderOAuth2DeviceCode;
        const deviceAuthId = oauthSession.connectionConfig[DEVICE_AUTH_ID_KEY];
        const userCode = oauthSession.connectionConfig[USER_CODE_KEY];
        const pollUrl = makeUrl(deviceProvider.device_token_poll_url, oauthSession.connectionConfig).href;

        let pollData: Record<string, any>;
        try {
            const pollResponse = await axios.post(
                pollUrl,
                { device_auth_id: deviceAuthId, user_code: userCode },
                { headers: { 'Content-Type': 'application/json' } }
            );
            pollData = pollResponse.data;
        } catch (err: any) {
            // The device-code endpoint returns 403/404 while the user has not yet approved; surface that as a retryable pending state.
            const status = err?.response?.status;
            if (status === 403 || status === 404) {
                res.status(202).send({ error: { code: 'authorization_pending', message: 'Authorization is still pending' } });
                return;
            }
            // Any other 4xx is a terminal device-code failure (expired/denied/invalid); stop polling with a typed error instead of a 500.
            if (typeof status === 'number' && status >= 400 && status < 500) {
                void logCtx.error('Device authorization failed', { status });
                await logCtx.failed();
                await oAuthSessionService.delete(state);
                res.status(400).send({ error: { code: 'token_exchange_failed', message: 'Device authorization failed or expired. Restart the connection.' } });
                return;
            }
            throw err;
        }

        const authorizationCode = pollData?.['authorization_code'];
        const codeVerifier = pollData?.['code_verifier'];

        if (!authorizationCode || !codeVerifier) {
            res.status(202).send({ error: { code: 'authorization_pending', message: 'Authorization is still pending' } });
            return;
        }

        const tokenUrl = makeUrl(deviceProvider.token_url as string, oauthSession.connectionConfig).href;

        let rawCredentials: object;
        try {
            rawCredentials = await providerClientManager.getToken(config, tokenUrl, authorizationCode, deviceProvider.redirect_uri, codeVerifier);
        } catch (err) {
            void logCtx.error('Token exchange failed', { error: err });
            await logCtx.failed();
            res.status(400).send({ error: { code: 'token_exchange_failed', message: 'Failed to exchange the authorization code for tokens' } });
            return;
        }

        const parsedRawCredentials = connectionService.parseRawCredentials(
            rawCredentials,
            'OAUTH2',
            deviceProvider as unknown as ProviderOAuth2
        ) as OAuth2Credentials;

        const tokenMetadata = getConnectionMetadata(rawCredentials, deviceProvider, 'token_response_metadata');

        const { [DEVICE_AUTH_ID_KEY]: _deviceAuthId, [USER_CODE_KEY]: _userCode, ...persistedConnectionConfig } = oauthSession.connectionConfig;

        const [updatedConnection] = await connectionService.upsertConnection({
            connectionId,
            providerConfigKey,
            parsedRawCredentials,
            connectionConfig: { ...persistedConnectionConfig, ...tokenMetadata },
            environmentId: environment.id,
            tags: connectSession?.tags
        });

        if (!updatedConnection) {
            res.status(500).send({ error: { code: 'server_error', message: 'failed to create connection' } });
            void logCtx.error('Failed to create connection');
            await logCtx.failed();
            return;
        }

        const customValidationResponse = await validateConnection({ connection: updatedConnection.connection, config, account, logCtx });
        if (customValidationResponse.isErr()) {
            void logCtx.error('Connection failed custom validation', { error: customValidationResponse.error });
            await logCtx.failed();

            if (updatedConnection.operation === 'creation') {
                await connectionService.hardDelete(updatedConnection.connection.id);
            }

            const payload = customValidationResponse.error?.payload;
            const message = typeof payload['message'] === 'string' ? payload['message'] : 'Connection failed validation';
            res.status(400).send({ error: { code: 'connection_validation_failed', message } });
            return;
        }

        await oAuthSessionService.delete(state);

        if (isConnectSession) {
            await syncEndUserToConnection(db.knex, { connectSession, connection: updatedConnection.connection, account, environment });
        }

        await logCtx.enrichOperation({ connectionId: updatedConnection.connection.id, connectionName: updatedConnection.connection.connection_id });
        void logCtx.info('Device code OAuth connection creation was successful');
        await logCtx.success();

        void connectionCreatedHook(
            {
                connection: updatedConnection.connection,
                environment,
                account,
                auth_mode: 'OAUTH2_DEVICE_CODE',
                operation: updatedConnection.operation,
                endUser: res.locals.endUser
            },
            account,
            config,
            logContextGetter
        );

        metrics.increment(metrics.Types.AUTH_SUCCESS, 1, { auth_mode: 'OAUTH2_DEVICE_CODE', provider: config.provider });

        res.status(200).send({ connectionId, providerConfigKey });
    } catch (err) {
        const prettyError = stringifyError(err, { pretty: true });

        void connectionCreationFailedHook(
            {
                connection: { connection_id: connectionId, provider_config_key: providerConfigKey },
                environment,
                account,
                auth_mode: 'OAUTH2_DEVICE_CODE',
                error: { type: 'unknown', description: `Error during device code OAuth create: ${prettyError}` },
                operation: 'unknown'
            },
            account
        );

        if (logCtx) {
            void logCtx.error('Error during device code OAuth polling', { error: err });
            await logCtx.failed();
        }

        errorManager.report(err, {
            source: ErrorSourceEnum.PLATFORM,
            operation: LogActionEnum.AUTH,
            environmentId: environment.id,
            metadata: { providerConfigKey, connectionId }
        });

        metrics.increment(metrics.Types.AUTH_FAILURE, 1, { auth_mode: 'OAUTH2_DEVICE_CODE', ...(config ? { provider: config.provider } : {}) });

        next(err);
    }
});
