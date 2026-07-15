/**
 * Thin API client. Auth travels in the httpOnly cookie set by the server —
 * nothing sensitive is stored in localStorage.
 * A 422 CONFIRMATION_REQUIRED response is not an error: it is the server
 * asking the user to explicitly confirm (10% threshold flow); callers
 * receive it as { confirmationRequired: true, ... }.
 */
const API = {
  async request(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }

    if (res.status === 401 && !path.startsWith("/api/auth")) {
      window.App?.onUnauthorized();
      throw Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED" });
    }
    if (res.status === 422 && data?.error === "CONFIRMATION_REQUIRED") {
      return { confirmationRequired: true, ...data };
    }
    if (!res.ok) {
      throw Object.assign(new Error(data?.message || data?.error || `HTTP_${res.status}`), { code: data?.error, status: res.status });
    }
    return data;
  },
  get(path) { return this.request("GET", path); },
  post(path, body) { return this.request("POST", path, body); },
  put(path, body) { return this.request("PUT", path, body); },
};
window.API = API;
