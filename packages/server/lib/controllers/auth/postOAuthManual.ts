import * as crypto from 'node:crypto';

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
    getProvider,
    makeUrl,
    providerClientManager,
    syncEndUserToConnection
} from '@nangohq/shared';
import { metrics, stringifyError, zodErrorToHTTP } from '@nangohq/utils';

import { buildCodeChallenge, parseAuthorizationResponse } from './oauthManual.helpers.js';
import { connectionCredential, connectionIdSchema, providerConfigKeySchema } from '../../helpers/validation.js';
import { validateConnection } from '../../hooks/connection/on/validate-connection.js';
import { connectionCreated as connectionCreatedHook, connectionCreationFailed as connectionCreationFailedHook } from '../../hooks/hooks.js';
import oAuthSessionService from '../../services/oauth-session.service.js';
import { asyncWrapper } from '../../utils/asyncWrapper.js';
import { errorRestrictConnectionId, isIntegrationAllowed } from '../../utils/auth.js';
import { hmacCheck } from '../../utils/hmac.js';

import type { LogContext } from '@nangohq/logs';
import type { Config as ProviderConfig } from '@nangohq/shared';
import type { OAuth2Credentials, PostPublicOAuthManualComplete, PostPublicOAuthManualStart, ProviderOAuth2, ProviderOAuth2Manual } from '@nangohq/types';

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

const completeBodyValidation = z
    .object({
        authorization_response: z.string().min(1).optional(),
        code: z.string().min(1).optional(),
        state: z.string().min(1).optional()
    })
    .strict()
    .refine((data) => Boolean(data.authorization_response) || Boolean(data.code), {
        message: 'Provide either authorization_response or code'
    });

const completeQueryValidation = z.object({}).and(connectionCredential);

export const postPublicOAuthManualStart = asyncWrapper<PostPublicOAuthManualStart>(async (req, res, next) => {
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
                          meta: { authType: 'oauth2_manual', connectSession: endUserToMeta(res.locals.endUser) },
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

        if (provider.auth_mode !== 'OAUTH2_MANUAL') {
            void logCtx.error('Provider does not support manual OAuth', { provider: config.provider });
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

        const manualProvider = provider as ProviderOAuth2Manual;
        const codeVerifier = crypto.randomBytes(32).toString('hex');
        const state = uuid.v4();

        const authorizationUrl = new URL(makeUrl(manualProvider.authorization_url!, connectionConfig).href);
        const scopeSeparator = manualProvider.scope_separator || ' ';
        const scopes = config.oauth_scopes ? config.oauth_scopes.split(',').join(scopeSeparator) : '';

        const authParams: Record<string, string> = {
            client_id: config.oauth_client_id,
            redirect_uri: manualProvider.redirect_uri,
            response_type: 'code',
            state,
            code_challenge: buildCodeChallenge(codeVerifier),
            code_challenge_method: 'S256',
            ...(manualProvider.authorization_params || {})
        };

        if (scopes) {
            authParams['scope'] = scopes;
        }

        for (const [key, value] of Object.entries(authParams)) {
            authorizationUrl.searchParams.set(key, value);
        }

        await oAuthSessionService.create({
            id: state,
            providerConfigKey,
            provider: config.provider,
            connectionId,
            callbackUrl: manualProvider.redirect_uri,
            authMode: 'OAUTH2_MANUAL',
            connectSessionId: isConnectSession ? connectSession.id : null,
            connectionConfig,
            environmentId: environment.id,
            webSocketClientId: undefined,
            activityLogId: logCtx.id,
            codeVerifier,
            requestTokenSecret: null,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        void logCtx.info('Manual OAuth authorization started', { providerConfigKey, connectionId, provider: config.provider });

        res.status(200).send({ authorizationUrl: authorizationUrl.toString(), state, connectionId });
    } catch (err) {
        if (logCtx) {
            void logCtx.error('Error during manual OAuth start', { error: err });
            await logCtx.failed();
        }

        errorManager.report(err, {
            source: ErrorSourceEnum.PLATFORM,
            operation: LogActionEnum.AUTH,
            environmentId: environment.id,
            metadata: { providerConfigKey, connectionId }
        });

        metrics.increment(metrics.Types.AUTH_FAILURE, 1, { auth_mode: 'OAUTH2_MANUAL', ...(config ? { provider: config.provider } : {}) });

        next(err);
    }
});

export const postPublicOAuthManualComplete = asyncWrapper<PostPublicOAuthManualComplete>(async (req, res, next) => {
    const bodyVal = completeBodyValidation.safeParse(req.body);
    if (!bodyVal.success) {
        res.status(400).send({ error: { code: 'invalid_body', errors: zodErrorToHTTP(bodyVal.error) } });
        return;
    }

    const queryVal = completeQueryValidation.safeParse(req.query);
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
    const body = bodyVal.data;
    const { providerConfigKey } = paramVal.data;
    const isConnectSession = res.locals['authType'] === 'connectSession';

    let code: string;
    let state: string | undefined;
    if (body.authorization_response) {
        const parsed = parseAuthorizationResponse(body.authorization_response);
        code = parsed.code;
        state = parsed.state ?? body.state;
    } else {
        code = body.code!;
        state = body.state;
    }

    let logCtx: LogContext | undefined;
    let config: ProviderConfig | null = null;
    let connectionId = '';

    try {
        if (!code || !state) {
            res.status(400).send({ error: { code: 'invalid_body', message: 'Missing authorization code or state' } });
            return;
        }

        const oauthSession = await oAuthSessionService.findById(state);
        if (!oauthSession || oauthSession.providerConfigKey !== providerConfigKey || oauthSession.authMode !== 'OAUTH2_MANUAL') {
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
                          meta: { authType: 'oauth2_manual', connectSession: endUserToMeta(res.locals.endUser) },
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
        if (!provider || provider.auth_mode !== 'OAUTH2_MANUAL') {
            void logCtx.error('Provider does not support manual OAuth');
            await logCtx.failed();
            res.status(400).send({ error: { code: 'invalid_auth_mode' } });
            return;
        }

        if (!(await isIntegrationAllowed({ config, res, logCtx }))) {
            return;
        }

        const manualProvider = provider as ProviderOAuth2Manual;
        const tokenUrl = makeUrl(manualProvider.token_url as string, oauthSession.connectionConfig).href;

        let rawCredentials: object;
        try {
            rawCredentials = await providerClientManager.getToken(config, tokenUrl, code, manualProvider.redirect_uri, oauthSession.codeVerifier!, {
                ...oauthSession.connectionConfig,
                oauth_state: state
            });
        } catch (err) {
            void logCtx.error('Token exchange failed', { error: err });
            await logCtx.failed();
            res.status(400).send({ error: { code: 'token_exchange_failed', message: 'Failed to exchange the authorization code for tokens' } });
            return;
        }

        const parsedRawCredentials = connectionService.parseRawCredentials(
            rawCredentials,
            'OAUTH2',
            manualProvider as unknown as ProviderOAuth2
        ) as OAuth2Credentials;

        const [updatedConnection] = await connectionService.upsertConnection({
            connectionId,
            providerConfigKey,
            parsedRawCredentials,
            connectionConfig: oauthSession.connectionConfig,
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
        void logCtx.info('Manual OAuth connection creation was successful');
        await logCtx.success();

        void connectionCreatedHook(
            {
                connection: updatedConnection.connection,
                environment,
                account,
                auth_mode: 'OAUTH2_MANUAL',
                operation: updatedConnection.operation,
                endUser: res.locals.endUser
            },
            account,
            config,
            logContextGetter
        );

        metrics.increment(metrics.Types.AUTH_SUCCESS, 1, { auth_mode: 'OAUTH2_MANUAL', provider: config.provider });

        res.status(200).send({ connectionId, providerConfigKey });
    } catch (err) {
        const prettyError = stringifyError(err, { pretty: true });

        void connectionCreationFailedHook(
            {
                connection: { connection_id: connectionId, provider_config_key: providerConfigKey },
                environment,
                account,
                auth_mode: 'OAUTH2_MANUAL',
                error: { type: 'unknown', description: `Error during manual OAuth create: ${prettyError}` },
                operation: 'unknown'
            },
            account
        );

        if (logCtx) {
            void logCtx.error('Error during manual OAuth completion', { error: err });
            await logCtx.failed();
        }

        errorManager.report(err, {
            source: ErrorSourceEnum.PLATFORM,
            operation: LogActionEnum.AUTH,
            environmentId: environment.id,
            metadata: { providerConfigKey, connectionId }
        });

        metrics.increment(metrics.Types.AUTH_FAILURE, 1, { auth_mode: 'OAUTH2_MANUAL', ...(config ? { provider: config.provider } : {}) });

        next(err);
    }
});
