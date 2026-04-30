const NOTION_API_BASE = 'https://api.notion.com/v1'
const NOTION_DB_ID = '3529b4d8501b80879314e575e0618c49'
const NOTION_VERSION = '2022-06-28'

export default async function handler(req, res) {
  const notionToken = process.env.NOTION_TOKEN

  if (!notionToken) {
    return res.status(500).json({ error: 'NOTION_TOKEN is not configured' })
  }

  const { method, body } = req
  const path = req.query.path || `databases/${NOTION_DB_ID}/query`

  const url = `${NOTION_API_BASE}/${path}`

  const headers = {
    'Authorization': `Bearer ${notionToken}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  }

  try {
    const options = {
      method,
      headers
    }

    if (method !== 'GET' && body) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body)
    }

    const response = await fetch(url, options)
    const data = await response.json()

    res.status(response.status).json(data)
  } catch (error) {
    res.status(500).json({ error: 'Failed to proxy request to Notion API', details: error.message })
  }
}
