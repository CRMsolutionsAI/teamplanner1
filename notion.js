/**
 * Vercel Serverless Function — Notion API Proxy
 * Proxies all requests from the frontend to Notion.
 *
 * ENV variables (set in Vercel dashboard):
 *   NOTION_TOKEN   — ваш Internal Integration Token
 *   NOTION_DB      — ID базы данных в Notion
 */

const NOTION_VER = "2022-06-28";
const CHUNK = 1900; // Notion rich_text limit per item

async function notionFetch(path, method = "GET", body = null) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion ${method} ${path} → ${res.status}: ${err}`);
  }
  return res.json();
}

// Разбить строку на чанки по 1900 символов (обход лимита Notion)
function toRichText(value) {
  const chunks = [];
  for (let i = 0; i < value.length; i += CHUNK) {
    chunks.push({ type: "text", text: { content: value.slice(i, i + CHUNK) } });
  }
  return chunks.length ? chunks : [{ type: "text", text: { content: "" } }];
}

// Найти страницу в базе по ключу (title)
async function findPage(key) {
  const result = await notionFetch(
    `/databases/${process.env.NOTION_DB}/query`,
    "POST",
    { filter: { property: "title", title: { equals: key } } }
  );
  return result.results?.[0] || null;
}

// Прочитать значение из code-блока страницы
async function readPageValue(pageId) {
  const blocks = await notionFetch(`/blocks/${pageId}/children`);
  const code = blocks.results?.find((b) => b.type === "code");
  if (!code) return null;
  return code.code.rich_text.map((r) => r.plain_text).join("");
}

// Записать/обновить code-блок на странице
async function writePageValue(pageId, value) {
  const blocks = await notionFetch(`/blocks/${pageId}/children`);
  const code = blocks.results?.find((b) => b.type === "code");
  const richText = toRichText(value);

  if (code) {
    await notionFetch(`/blocks/${code.id}`, "PATCH", {
      code: { rich_text: richText, language: "json" },
    });
  } else {
    await notionFetch(`/blocks/${pageId}/children`, "PATCH", {
      children: [{ type: "code", code: { rich_text: richText, language: "json" } }],
    });
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ── GET /api/notion?key=xxx  — прочитать значение
    if (req.method === "GET" && req.query.key) {
      const page = await findPage(req.query.key);
      if (!page) return res.json({ value: null });
      const value = await readPageValue(page.id);
      return res.json({ value });
    }

    // ── GET /api/notion?prefix=xxx  — список ключей
    if (req.method === "GET" && req.query.prefix) {
      const result = await notionFetch(
        `/databases/${process.env.NOTION_DB}/query`,
        "POST",
        { filter: { property: "title", title: { starts_with: req.query.prefix } } }
      );
      const keys = result.results
        .map((p) => p.properties.title?.title?.[0]?.plain_text)
        .filter(Boolean);
      return res.json({ keys });
    }

    // ── POST /api/notion  { key, value }  — сохранить
    if (req.method === "POST") {
      const { key, value } = req.body;
      const page = await findPage(key);

      if (page) {
        await writePageValue(page.id, value);
      } else {
        const newPage = await notionFetch("/pages", "POST", {
          parent: { database_id: process.env.NOTION_DB },
          properties: {
            title: { title: [{ type: "text", text: { content: key } }] },
          },
        });
        await writePageValue(newPage.id, value);
      }
      return res.json({ ok: true });
    }

    // ── DELETE /api/notion?key=xxx  — удалить
    if (req.method === "DELETE" && req.query.key) {
      const page = await findPage(req.query.key);
      if (page) {
        await notionFetch(`/pages/${page.id}`, "PATCH", { archived: true });
      }
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[notion proxy]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
