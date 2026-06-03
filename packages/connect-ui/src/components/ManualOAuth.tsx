import { ExternalLink, TriangleAlert } from 'lucide-react';
import { useCallback, useState } from 'react';

import { AuthError } from '@nangohq/frontend';

import { Button } from '@/components/ui/button';
import { useNango } from '@/lib/nango';
import { compactErrorDisplay } from '@/lib/utils';

import type { AuthResult } from '@nangohq/frontend';

interface ManualOAuthProps {
    integrationKey: string;
    displayName: string;
    logo: string;
    onResult: (res: AuthResult) => void;
}

function errorMessage(err: unknown, fallback: string): string {
    if (err instanceof AuthError) {
        return err.message;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return fallback;
}

const POPUP_NAME = 'nango-manual-oauth';

function popupFeatures(): string {
    const width = 500;
    const height = 700;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

export const ManualOAuth: React.FC<ManualOAuthProps> = ({ integrationKey, displayName, logo, onResult }) => {
    const nango = useNango();

    const [phase, setPhase] = useState<'idle' | 'awaiting_code'>('idle');
    const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
    const [code, setCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleStart = useCallback(async () => {
        if (!nango || loading) {
            return;
        }
        setLoading(true);
        setError(null);

        // Open the popup synchronously inside the click handler; browsers block window.open after an await.
        const popup = window.open('', POPUP_NAME, popupFeatures());

        try {
            const res = await nango.manualOAuthStart(integrationKey);
            setAuthorizationUrl(res.authorizationUrl);
            if (popup && !popup.closed) {
                popup.location.href = res.authorizationUrl;
                popup.focus();
            } else {
                window.open(res.authorizationUrl, POPUP_NAME, popupFeatures());
            }
            setPhase('awaiting_code');
        } catch (err) {
            if (popup && !popup.closed) {
                popup.close();
            }
            setError(errorMessage(err, 'Failed to start authorization'));
        } finally {
            setLoading(false);
        }
    }, [nango, integrationKey, loading]);

    const handleComplete = useCallback(async () => {
        if (!nango || loading || !code.trim()) {
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const res = await nango.manualOAuthComplete(integrationKey, code.trim());
            onResult(res);
        } catch (err) {
            setError(errorMessage(err, 'Failed to complete authorization'));
        } finally {
            setLoading(false);
        }
    }, [nango, integrationKey, code, loading, onResult]);

    return (
        <main className="flex-1 flex flex-col gap-7 px-4 justify-center">
            <div className="flex flex-col gap-7 items-center">
                <div className="w-16 h-16 p-2 rounded-sm bg-white border border-subtle">
                    <img alt={`${displayName} logo`} src={logo} />
                </div>
                <h1 className="font-semibold text-center text-lg text-text-primary">Link {displayName} Account</h1>
            </div>

            {error && (
                <p className="p-4 py-2 rounded-md flex gap-2 text-sm bg-yellow-100 border border-yellow-300 text-yellow-700">
                    <TriangleAlert className="w-5 h-5 shrink-0" />
                    {compactErrorDisplay(error)}
                </p>
            )}

            {phase === 'idle' ? (
                <div className="flex flex-col gap-7">
                    <p className="text-center text-sm text-text-secondary">
                        Click connect to authorize with {displayName}. A popup opens — approve access, then copy the code {displayName} shows you and paste it
                        back here.
                    </p>
                    <Button className="w-full" loading={loading} size="lg" onClick={handleStart}>
                        Connect
                    </Button>
                </div>
            ) : (
                <div className="flex flex-col gap-5">
                    <p className="text-center text-sm text-text-secondary">
                        {' '}
                        Approve access in the popup that opened, then paste the authorization code below.
                    </p>
                    {authorizationUrl && (
                        <button
                            className="text-center text-sm underline text-text-primary inline-flex items-center justify-center gap-1"
                            type="button"
                            onClick={() => window.open(authorizationUrl, POPUP_NAME, popupFeatures())}
                        >
                            Reopen authorization page
                            <ExternalLink className="inline-block w-3.5 h-3.5" />
                        </button>
                    )}
                    <div className="bg-elevated p-5 flex flex-col gap-2">
                        <label className="text-xs font-semibold text-text-primary" htmlFor="manual-oauth-code">
                            Authorization code <span className="text-error">*</span>
                        </label>
                        <input
                            autoComplete="off"
                            className="bg-surface w-full shadow-xs rounded-sm border border-border-muted text-sm h-9 px-3 py-1 text-text-primary placeholder-text-text-secondary outline-none focus:border-border-default focus:ring-1 focus:ring-brand-500/20"
                            id="manual-oauth-code"
                            placeholder="Paste the code here"
                            type="text"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                        />
                    </div>
                    <Button className="w-full" disabled={!code.trim()} loading={loading} size="lg" onClick={handleComplete}>
                        Finish
                    </Button>
                </div>
            )}
        </main>
    );
};
