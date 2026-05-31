// ../browser-agent/opencli/clis/douyin/delete.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/douyin/_shared/browser-fetch.js

// ../browser-agent/opencli/clis/douyin/_shared/evaluate-result.js

function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
    return payload.data;
  }
  return payload;
}
function requireObjectEvaluateResult(payload, context) {
  const result = unwrapEvaluateResult(payload);
  if (!result || Array.isArray(result) || typeof result !== "object") {
    throw new CommandExecutionError(`${context}: malformed evaluate payload`);
  }
  return result;
}

// ../browser-agent/opencli/clis/douyin/_shared/browser-fetch.js
function isAuthLikeError(code, message) {
  const text = String(message ?? "");
  return code === 401 || code === 403 || /login|cookie|auth|captcha|verify|forbidden|permission|登录|登陆|权限|验证|验证码/i.test(text);
}
async function browserFetch(page, method, url, options = {}) {
  const js = `
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${Number(options.timeoutMs ?? 3e4)});
      try {
        const res = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(method)},
          credentials: 'include',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...${JSON.stringify(options.headers ?? {})}
          },
          ${options.body ? `body: JSON.stringify(${JSON.stringify(options.body)}),` : ""}
        });
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch (error) {
          return { status_code: res.ok ? -2 : res.status, status_msg: \`JSON parse failed: \${text.slice(0, 500) || String(error && error.message || error)}\` };
        }
      } catch (error) {
        return { status_code: -1, status_msg: String(error && error.message || error) };
      } finally {
        clearTimeout(timer);
      }
    })()
  `;
  let result;
  try {
    result = unwrapEvaluateResult(await page.evaluate(js));
  } catch (error) {
    throw new CommandExecutionError(`Douyin API request failed (${method} ${url}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result == null) {
    throw new CommandExecutionError(`Empty response from Douyin API (${method} ${url})`);
  }
  if (Array.isArray(result) || typeof result !== "object") {
    throw new CommandExecutionError(`Malformed response from Douyin API (${method} ${url})`);
  }
  if (result && typeof result === "object" && "status_code" in result) {
    const code = result.status_code;
    if (code !== 0) {
      const msg = result.status_msg ?? result.message ?? "unknown error";
      if (isAuthLikeError(code, msg)) {
        throw new AuthRequiredError("creator.douyin.com", `Douyin API auth/permission error ${code} at ${method} ${url}: ${msg}`);
      }
      throw new CommandExecutionError(`Douyin API error ${code} at ${method} ${url}: ${msg}`);
    }
  }
  return result;
}

// ../browser-agent/opencli/clis/douyin/delete.js
var CREATOR_MANAGE_URL = "https://creator.douyin.com/creator-micro/content/manage";
var WORK_LIST_URL = "/janus/douyin/creator/pc/work_list?status=0&count=20&max_cursor=0&scene=star_atlas&device_platform=android&aid=1128";
function readAwemeId(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw new ArgumentError("douyin delete aweme_id cannot be empty");
  }
  if (!/^\d+$/.test(value)) {
    throw new ArgumentError("douyin delete aweme_id must be a numeric id");
  }
  return value;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function deleteViaCreatorManage(page, workId) {
  await page.goto(CREATOR_MANAGE_URL);
  await sleep(3e3);
  await sleep(3e3);
  const result = requireObjectEvaluateResult(await page.evaluate(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const targetId = ${JSON.stringify(String(workId))};
      const textOf = (node) => (node && (node.innerText || node.textContent) || '').trim();
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();

      async function loadTarget() {
        const res = await fetch(${JSON.stringify(WORK_LIST_URL)}, { credentials: 'include' });
        const payload = await res.json();
        const list = Array.isArray(payload.aweme_list) ? payload.aweme_list : [];
        const matches = list
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => String(entry.aweme_id || '') === targetId || String(entry.item_id || '') === targetId);
        if (matches.length === 0) {
          return { ok: false, reason: 'not_found', status_code: payload.status_code, count: list.length };
        }
        if (matches.length !== 1) {
          return { ok: false, reason: 'target_not_unique', count: matches.length };
        }
        const { entry: item, index } = matches[0];
        const title = normalize(item.desc || item.caption || item.title || item.item_title || '');
        return { ok: true, item, index, listCount: list.length, title };
      }

      function visibleWorkCards() {
        const candidates = Array.from(document.querySelectorAll('[class*="video-card"]'))
          .filter((element) => {
            const text = normalize(textOf(element));
            return text.includes('删除作品') && text.includes('继续编辑');
          });
        return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)));
      }

      const target = await loadTarget();
      if (!target.ok) return target;

      const allTab = Array.from(document.querySelectorAll('button,[role="button"],span,div'))
        .find((element) => /^全部作品$/.test(normalize(textOf(element))));
      allTab?.click();
      await sleep(1000);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const cards = visibleWorkCards();
        if (cards.length >= target.listCount && cards[target.index]) {
          const card = cards[target.index];
          const deleteButton = Array.from(card.querySelectorAll('button,[role="button"],span,div'))
            .find((element) => /^删除作品$/.test(normalize(textOf(element))));
          if (!deleteButton) return { ok: false, reason: 'delete_button_not_found', aweme_id: target.item.aweme_id, item_id: target.item.item_id, index: target.index, cardCount: cards.length };
          deleteButton.click();
          await sleep(800);
          const confirmButton = Array.from(document.querySelectorAll('button,[role="button"]'))
            .find((element) => ['确定', '确认', '删除'].includes(normalize(textOf(element))));
          if (!confirmButton) return { ok: false, reason: 'confirm_button_not_found', aweme_id: target.item.aweme_id, item_id: target.item.item_id };
          confirmButton.click();
          for (let wait = 0; wait < 20; wait += 1) {
            await sleep(500);
            const after = await loadTarget();
            if (!after.ok && after.reason === 'not_found') {
              return { ok: true, aweme_id: target.item.aweme_id, item_id: target.item.item_id, title: target.title };
            }
          }
          return { ok: false, reason: 'delete_not_confirmed', aweme_id: target.item.aweme_id, item_id: target.item.item_id };
        }
        await sleep(500);
      }
      return { ok: false, reason: 'card_not_found', aweme_id: target.item.aweme_id, item_id: target.item.item_id, index: target.index, listCount: target.listCount };
    })()
  `), "抖音后台管理删除响应异常");
  if (!result?.ok) {
    throw new CommandExecutionError(`抖音后台管理删除失败: ${JSON.stringify(result)}`);
  }
  return result;
}
async function findWorkListItem(page, workId) {
  const data = await browserFetch(page, "GET", `https://creator.douyin.com${WORK_LIST_URL}`, { timeoutMs: 8e3 });
  const list = data.data?.work_list ?? data.aweme_list ?? data.work_list ?? [];
  if (!Array.isArray(list)) {
    throw new CommandExecutionError("抖音作品列表响应缺少 work_list/aweme_list");
  }
  return list.find((entry) => String(entry.aweme_id || "") === workId || String(entry.item_id || "") === workId) || null;
}
cli({
  site: "douyin",
  name: "delete",
  access: "write",
  description: "删除作品（优先使用创作者后台作品管理；找不到时回退到旧删除接口）",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  siteSession: "persistent",
  args: [
    { name: "aweme_id", required: true, positional: true, help: "作品 ID / item_id" }
  ],
  columns: ["status"],
  func: async (page, kwargs) => {
    const awemeId = readAwemeId(kwargs.aweme_id);
    try {
      const deleted = await deleteViaCreatorManage(page, awemeId);
      return [{ status: `✅ 已通过后台管理删除 ${deleted.aweme_id || awemeId}` }];
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      if (!fallbackMessage.includes('"reason":"not_found"')) {
        throw fallbackError;
      }
    }
    const before = await findWorkListItem(page, awemeId);
    if (!before) {
      throw new CommandExecutionError(`抖音作品 ${awemeId} 未在作品列表中找到，未执行删除`);
    }
    const url = "https://creator.douyin.com/web/api/media/aweme/delete/?aid=1128";
    await browserFetch(page, "POST", url, { body: { aweme_id: awemeId }, timeoutMs: 8e3 });
    const deadline = Date.now() + 1e4;
    while (Date.now() < deadline) {
      await sleep(500);
      const after = await findWorkListItem(page, awemeId);
      if (!after) {
        return [{ status: `✅ 已删除 ${awemeId}` }];
      }
    }
    throw new CommandExecutionError(`抖音作品 ${awemeId} 删除后仍在作品列表中，删除未确认`);
  }
});
