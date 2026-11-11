/**
 * Typed fetch wrapper around the Pivot Parlor Worker API.
 *
 * Usage in a loader:
 *   const api = createApiClient(context.env.API_URL, token);
 *   const data = await api.get<Shop[]>("/api/shops");
 */
import { isTraversalApiPath } from "~/lib/pathSafety";

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export function createApiClient(
  baseUrl: string,
  token?: string | null,
  extraHeaders?: Record<string, string>
): ApiClient {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    // Paths carry values from URLs (params, query strings). One that the URL
    // parser would resolve elsewhere (`\`, `..`, %2e) must not be sent,
    // least of all with the visitor's token.
    if (isTraversalApiPath(path)) {
      throw new Error("Refused an API path that resolves elsewhere");
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const json = (await res.json()) as { success?: boolean; data?: T; error?: string } & T;

    if (!res.ok) {
      throw new Error(
        (json as { error?: string }).error ?? `HTTP ${res.status}`
      );
    }

    // Unwrap { success, data } envelope if present
    if (
      typeof json === "object" &&
      json !== null &&
      "data" in json &&
      "success" in json
    ) {
      return json.data as T;
    }

    return json as T;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    del: (path) => request("DELETE", path),
  };
}
