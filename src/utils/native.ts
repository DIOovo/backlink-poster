export const NATIVE_HOST_NAME = 'com.backlinkposter.native';

export interface NativeWriteResult { ok: true; path: string; }
export interface NativePingResult { ok: true; version: string; outputRoot: string; }
export interface NativeError { ok: false; error: string; }

/** Native messaging is only available to extension pages (service worker, options). */
function supported(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.connectNative === 'function';
}

/**
 * One-shot request/response over a Chrome native messaging port.
 * Throws on timeout, host-not-installed, disconnect, or an {ok:false} reply.
 */
export async function nativeRequest<T = NativeWriteResult | NativePingResult>(message: object, timeoutMs = 20000): Promise<T> {
  if (!supported()) throw new Error('Native messaging is unavailable in this browser.');
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (e) {
    throw new Error(nativeUnavailable(e));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch { /* ignore */ }
      reject(new Error('Native file writer did not respond.'));
    }, timeoutMs);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    port.onMessage.addListener((msg) => {
      settle(() => {
        try { port.disconnect(); } catch { /* ignore */ }
        if (msg?.ok === true) resolve(msg as T);
        else if (msg?.ok === false) reject(new Error((msg as NativeError).error || 'Native file writer error.'));
        else reject(new Error('Unexpected response from native file writer.'));
      });
    });
    port.onDisconnect.addListener(() => {
      settle(() => reject(new Error(nativeUnavailable(chrome.runtime.lastError?.message))));
    });
    try {
      port.postMessage(message);
    } catch (e) {
      settle(() => reject(e as Error));
    }
  });
}

function nativeUnavailable(cause?: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause ?? '');
  if (/not found|no such|unavailable/i.test(text)) {
    return `Native file writer unavailable — install it with ./native-host/install.sh <EXTENSION_ID>.${text ? ' (' + text + ')' : ''}`;
  }
  return `Native file writer unavailable${text ? ': ' + text : ''}.`;
}

/** Write a captured screenshot (data URL) to outputRoot/<batchId>/screenshots/<filename>. */
export function writeScreenshot(batchId: string, filename: string, dataUrl: string): Promise<NativeWriteResult> {
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return nativeRequest<NativeWriteResult>({ action: 'writeScreenshot', batchId, filename, data });
}

/** Write results CSV text to outputRoot/<batchId>/results.csv. */
export function writeCsv(batchId: string, text: string): Promise<NativeWriteResult> {
  return nativeRequest<NativeWriteResult>({ action: 'writeCsv', batchId, filename: 'results.csv', data: text });
}

/** Probe the host and report its version + configured outputRoot. */
export function pingNative(): Promise<NativePingResult> {
  return nativeRequest<NativePingResult>({ action: 'ping' });
}