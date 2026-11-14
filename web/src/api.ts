export class ApiError extends Error {
  status: number;
  fields: Record<string, string>;
  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields || {};
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** Вызывается при 401 (сессия истекла) — приложение возвращает на экран входа. */
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, 'Нет связи с сервером. Проверьте сеть и повторите.');
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && url.indexOf('/api/auth/') < 0 && unauthorizedHandler) unauthorizedHandler();
    const msg = data && data.error ? data.error : 'Ошибка сервера (' + res.status + ')';
    throw new ApiError(res.status, msg, data && data.fields);
  }
  return data as T;
}

export function qs(params: Record<string, string | number | null | undefined>): string {
  const parts: string[] = [];
  Object.keys(params).forEach(function (k) {
    const v = params[k];
    if (v !== null && v !== undefined && v !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

export const api = {
  get<T>(url: string) {
    return request<T>('GET', url);
  },
  post<T>(url: string, body: unknown = {}) {
    return request<T>('POST', url, body);
  },
  put<T>(url: string, body: unknown) {
    return request<T>('PUT', url, body);
  },
  del<T>(url: string) {
    return request<T>('DELETE', url);
  },
};
