import { Check, Copy, ExternalLink, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AuthError } from '@nangohq/frontend';

import { Button } from '@/components/ui/button';
import { useNango } from '@/lib/nango';
import { compactErrorDisplay } from '@/lib/utils';

import type { AuthResult } from '@nangohq/frontend';

interface DeviceCodeProps {
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

interface StartedState {
    userCode: string;
    verificationUri: string;
    interval: number;
    state: string;
}

const POPUP_NAME = 'nango-device-code';

function popupFeatures(): string {
    const width = 500;
    const height = 700;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

async function writeToClipboard(value: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch {
        void 0;
    }

    // The Connect UI runs embedded, where the async clipboard API is frequently blocked; fall back to a temporary selection + execCommand.
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let success = false;
    try {
        success = document.execCommand('copy');
    } catch {
        success = false;
    }
    document.body.removeChild(textarea);
    return success;
}

export const DeviceCode: React.FC<DeviceCodeProps> = ({ integrationKey, displayName, logo, onResult }) => {
    const nango = useNango();

    const [started, setStarted] = useState<StartedState | null>(null);
    const [loading, setLoading] = useState(false);
    const [polling, setPolling] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const cancelled = useRef(false);
    const onResultRef = useRef(onResult);
    onResultRef.current = onResult;

    useEffect(() => {
        return () => {
            cancelled.current = true;
        };
    }, []);

    const handleStart = useCallback(async () => {
        if (!nango || loading) {
            return;
        }
        setLoading(true);
        setError(null);

        // Open the popup synchronously inside the click handler; browsers block window.open after an await.
        const popup = window.open('', POPUP_NAME, popupFeatures());

        try {
            const res = await nango.deviceCodeStart(integrationKey);
            setStarted({ userCode: res.userCode, verificationUri: res.verificationUri, interval: res.interval, state: res.state });

            // Copy while the parent document still has focus and before navigating the popup; the clipboard write fails once focus moves.
            window.focus();
            const didCopy = await writeToClipboard(res.userCode);
            if (didCopy) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }

            if (popup && !popup.closed) {
                popup.location.href = res.verificationUri;
            } else {
                window.open(res.verificationUri, POPUP_NAME, popupFeatures());
            }
            setPolling(true);
        } catch (err) {
            if (popup && !popup.closed) {
                popup.close();
            }
            setError(errorMessage(err, 'Failed to start authorization'));
        } finally {
            setLoading(false);
        }
    }, [nango, integrationKey, loading]);

    useEffect(() => {
        if (!polling || !started || !nango) {
            return;
        }

        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;

        const poll = async () => {
            try {
                const res = await nango.deviceCodePoll(integrationKey, started.state);
                if (cancelled.current || stopped) {
                    return;
                }
                if (res.status === 'complete') {
                    setPolling(false);
                    onResultRef.current(res);
                    return;
                }
                timer = setTimeout(poll, started.interval * 1000);
            } catch (err) {
                if (cancelled.current || stopped) {
                    return;
                }
                setPolling(false);
                setError(errorMessage(err, 'Failed to complete authorization'));
            }
        };

        timer = setTimeout(poll, started.interval * 1000);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [polling, started, nango, integrationKey]);

    const handleCopy = useCallback(async () => {
        if (!started) {
            return;
        }
        if (await writeToClipboard(started.userCode)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }, [started]);

    const handleReopen = useCallback(() => {
        if (!started) {
            return;
        }
        window.open(started.verificationUri, POPUP_NAME, popupFeatures());
    }, [started]);

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

            {!started ? (
                <div className="flex flex-col gap-7">
                    <p className="text-center text-sm text-text-secondary">
                        Click connect to authorize with {displayName}. A popup opens with your code already copied — paste it there, then approve access.
                    </p>
                    <Button className="w-full" loading={loading} size="lg" onClick={handleStart}>
                        Connect
                    </Button>
                </div>
            ) : (
                <div className="flex flex-col gap-5">
                    <p className="text-center text-sm text-text-secondary">Paste this code in the {displayName} popup, then approve access.</p>
                    <div className="bg-elevated p-5 flex flex-col gap-3 items-center">
                        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Your code</span>
                        <button
                            aria-label="Copy code"
                            className="text-2xl font-mono font-semibold tracking-[0.3em] inline-flex items-center gap-3 cursor-pointer transition-colors data-copied:text-green-600 text-text-primary"
                            data-copied={copied ? '' : undefined}
                            type="button"
                            onClick={handleCopy}
                        >
                            {started.userCode}
                            {copied ? (
                                <Check className="w-4 h-4 text-green-600 transition-transform duration-150 scale-110" />
                            ) : (
                                <Copy className="w-4 h-4 text-text-secondary transition-transform duration-150 active:scale-90" />
                            )}
                        </button>
                        <span
                            aria-live="polite"
                            className="text-xs font-medium text-green-600 transition-opacity duration-150 data-visible:opacity-100 opacity-0"
                            data-visible={copied ? '' : undefined}
                        >
                            Copied!
                        </span>
                    </div>
                    <button
                        className="text-center text-sm underline text-text-primary inline-flex items-center justify-center gap-1"
                        type="button"
                        onClick={handleReopen}
                    >
                        Reopen authorization popup
                        <ExternalLink className="inline-block w-3.5 h-3.5" />
                    </button>
                    {polling && <p className="text-center text-sm text-text-secondary">Waiting for you to approve access in the popup…</p>}
                </div>
            )}
        </main>
    );
};
