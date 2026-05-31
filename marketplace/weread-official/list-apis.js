// ../browser-agent/opencli/clis/weread-official/list-apis.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/weread-official/utils.js
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError
} from "@jackwener/opencli/errors";
var WEREAD_GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";
var WEREAD_DOMAIN = "weread.qq.com";
var SKILL_VERSION = "1.0.3";
var DEFAULT_TIMEOUT_MS = 3e4;
var AUTH_ERRCODES = /* @__PURE__ */ new Set([-2010, -2012]);
function getApiKey() {
  const key = String(process.env.WEREAD_API_KEY ?? "").trim();
  if (!key) {
    throw new AuthRequiredError(
      WEREAD_DOMAIN,
      "WEREAD_API_KEY is not set. Export it with `export WEREAD_API_KEY=<wrk-...>`."
    );
  }
  return key;
}
function buildGatewayBody(apiName, params = {}) {
  if (!apiName || typeof apiName !== "string") {
    throw new ArgumentError("weread-official: api_name is required");
  }
  const body = { api_name: apiName, skill_version: SKILL_VERSION };
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === void 0 || value === null || value === "") continue;
    body[key] = value;
  }
  return body;
}
async function callGateway(apiName, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = getApiKey();
  const body = buildGatewayBody(apiName, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(WEREAD_GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new TimeoutError(`weread-official ${apiName}`, Math.round(timeoutMs / 1e3));
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(`weread-official ${apiName} request failed`, detail);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new CommandExecutionError(
      `weread-official ${apiName} HTTP ${response.status}`,
      "Check WeRead gateway availability and that WEREAD_API_KEY is still valid."
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(`weread-official ${apiName} returned invalid JSON`, detail);
  }
  if (payload && typeof payload === "object" && payload.upgrade_info) {
    const info = payload.upgrade_info;
    const required = info?.required_version ?? info?.version ?? "unknown";
    const message = info?.message ?? "WeRead skill version is outdated";
    throw new CommandExecutionError(
      `WeRead skill 需升级: ${message}. Required skill_version=${required}, current=${SKILL_VERSION}`,
      "Pull the latest weread-skills.zip and bump SKILL_VERSION in clis/weread-official/utils.js."
    );
  }
  const errcode = Number(payload?.errcode ?? 0);
  if (errcode !== 0) {
    const errmsg = String(payload?.errmsg ?? "unknown error");
    if (AUTH_ERRCODES.has(errcode)) {
      throw new AuthRequiredError(
        WEREAD_DOMAIN,
        `WEREAD_API_KEY rejected (errcode=${errcode}, ${errmsg}). Regenerate the key and re-export it.`
      );
    }
    throw new CommandExecutionError(
      `weread-official ${apiName} returned errcode=${errcode}`,
      errmsg
    );
  }
  return payload;
}
function emptyResult(command, hint) {
  throw new EmptyResultError(`weread-official ${command}`, hint);
}

// ../browser-agent/opencli/clis/weread-official/list-apis.js
cli({
  site: "weread-official",
  name: "list-apis",
  access: "read",
  description: "List every api_name supported by the WeRead agent gateway",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [],
  columns: ["rank", "apiName", "description", "required", "optional", "extras"],
  func: async () => {
    const payload = await callGateway("/_list", {});
    const apis = extractApiList(payload);
    if (apis.length === 0) {
      emptyResult("list-apis", "Gateway returned no api inventory.");
    }
    const rows = apis.map((entry, i) => {
      const required = formatParamList(entry?.required ?? entry?.requiredParams ?? entry?.params?.required);
      const optional = formatParamList(entry?.optional ?? entry?.optionalParams ?? entry?.params?.optional);
      const description = String(entry?.description ?? entry?.help ?? entry?.summary ?? "");
      const extras = summarizeExtras(entry, ["api_name", "apiName", "name", "description", "help", "summary", "required", "optional", "requiredParams", "optionalParams", "params"]);
      return {
        rank: i + 1,
        apiName: String(entry?.api_name ?? entry?.apiName ?? entry?.name ?? ""),
        description,
        required,
        optional,
        extras
      };
    });
    rows.push({
      rank: rows.length + 1,
      apiName: "(client)",
      description: "Local skill version reported with every gateway request",
      required: "",
      optional: "",
      extras: `SKILL_VERSION=${SKILL_VERSION}`
    });
    return rows;
  }
});
function extractApiList(payload) {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [payload?.apis, payload?.list, payload?.data, payload?.items, payload?.endpoints];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  if (Array.isArray(payload)) return payload;
  return [];
}
function formatParamList(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.map((entry) => typeof entry === "string" ? entry : entry?.name ?? entry?.param ?? "").filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    return Object.keys(value).filter(Boolean).join(", ");
  }
  return String(value);
}
function summarizeExtras(entry, knownKeys) {
  if (!entry || typeof entry !== "object") return "";
  const known = new Set(knownKeys);
  const rest = {};
  for (const [key, value] of Object.entries(entry)) {
    if (known.has(key)) continue;
    rest[key] = value;
  }
  if (Object.keys(rest).length === 0) return "";
  try {
    return JSON.stringify(rest);
  } catch {
    return "";
  }
}
