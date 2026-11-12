const TOKEN_STORAGE_KEY = 'ledgerline_jwt_token';

let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Ignore storage errors
  }
}

export function clearStoredToken() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function formatCents(cents, masked = false) {
  if (masked) return '$••••.••';
  const num = Number(cents || 0) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
}

export function dollarsToCents(input) {
  const cleaned = String(input ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return NaN;
  }
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : NaN;
}

export function newIdempotencyKey(prefix = 'ui') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export async function apiFetch(path, { method = 'GET', body = null, headers = {}, skipAuthRedirect = false } = {}) {
  const token = getStoredToken();
  const reqHeaders = { ...headers };
  if (body !== null && !reqHeaders['Content-Type']) {
    reqHeaders['Content-Type'] = 'application/json';
  }
  if (token && !reqHeaders.Authorization) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    method,
    headers: reqHeaders,
    body: body !== null ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    if (
      res.status === 401 &&
      !skipAuthRedirect &&
      unauthorizedHandler &&
      !path.startsWith('/api/auth/login')
    ) {
      unauthorizedHandler(data?.error || 'UNAUTHORIZED');
    }
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error || 'REQUEST_FAILED';
    err.data = data;
    throw err;
  }

  return data;
}

async function triggerCsvDownload(url, fallbackFilename) {
  const token = getStoredToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) {
    let msg = `Export failed (${res.status})`;
    try {
      const json = await res.json();
      msg = json.message || json.error || msg;
    } catch (_) {}
    throw new Error(msg);
  }

  const blob = await res.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = fallbackFilename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
}

export async function downloadAuditCsv(filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      params.set(k, String(v).trim());
    }
  }
  const qs = params.toString();
  await triggerCsvDownload(
    `/api/audit/logs/export${qs ? `?${qs}` : ''}`,
    `ledgerline-audit-logs-${new Date().toISOString().slice(0, 10)}.csv`
  );
}

export async function downloadStatementCsv(accountId, accountNumber, filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      params.set(k, String(v).trim());
    }
  }
  const qs = params.toString();
  await triggerCsvDownload(
    `/api/accounts/${encodeURIComponent(accountId)}/statement/export${qs ? `?${qs}` : ''}`,
    `ledgerline-statement-${accountNumber || accountId}.csv`
  );
}

/**
 * Authenticated Server-Sent Events client using fetch ReadableStream so the JWT
 * travels safely inside the Authorization header rather than query URLs.
 */
export function connectEventStream({ onEvent, onStatusChange }) {
  const controller = new AbortController();
  let stopped = false;

  async function pump() {
    while (!stopped) {
      const token = getStoredToken();
      if (!token) {
        onStatusChange?.('disconnected');
        return;
      }

      try {
        const res = await fetch('/api/events/stream', {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (!res.ok || !res.body) {
          onStatusChange?.('reconnecting');
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }

        onStatusChange?.('connected');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';

          for (const frame of frames) {
            if (!frame.trim() || frame.startsWith(':')) continue;
            const lines = frame.split('\n');
            let eventType = 'message';
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event:')) eventType = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (dataStr) {
              try {
                const parsed = JSON.parse(dataStr);
                onEvent?.({ type: eventType, ...parsed });
              } catch (_) {}
            }
          }
        }
      } catch (err) {
        if (stopped || err?.name === 'AbortError') return;
        onStatusChange?.('reconnecting');
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  pump();

  return () => {
    stopped = true;
    controller.abort();
  };
}
