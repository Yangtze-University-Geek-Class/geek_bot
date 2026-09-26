/**
 * 页面的数据状态：加载、空、成功、失败、未登录、无权限、离线分开表示（DESIGN「状态、表单和导航」）。
 * 网络错误不冒充空数据，无权限不冒充失败。本文件不导入 Vue。
 */
import { ApiError } from "./api.js";

export type PageState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly error: ApiError }
  | { readonly kind: "unauthenticated"; readonly error: ApiError }
  | { readonly kind: "forbidden"; readonly error: ApiError }
  | { readonly kind: "offline"; readonly error: ApiError };

/** 列表响应（`{ items: [...] }`）没有条目时算空；其它形状的响应不按空处理。 */
export function isEmptyResult(data: unknown): boolean {
  if (typeof data !== "object" || data === null || !("items" in data)) return false;
  const items = (data as { items: unknown }).items;
  return Array.isArray(items) && items.length === 0;
}

export function stateFromData<T>(data: T): PageState<T> {
  return isEmptyResult(data) ? { kind: "empty" } : { kind: "ready", data };
}

/** 请求失败对应的页面状态：401 → 未登录；403 → 无权限（含需要重新认证）；没有响应 → 离线；其余 → 失败。 */
export function stateFromError<T>(error: unknown): PageState<T> {
  const apiError = error instanceof ApiError ? error : new ApiError("invalid_response", error instanceof Error ? error.message : String(error));
  if (apiError.kind === "network") return { kind: "offline", error: apiError };
  if (apiError.status === 401) return { kind: "unauthenticated", error: apiError };
  if (apiError.status === 403) return { kind: "forbidden", error: apiError };
  return { kind: "error", error: apiError };
}
