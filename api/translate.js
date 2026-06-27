export default async function handler(req, res) {
  // CORS headers — allow any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { lines } = req.body;
  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'Missing lines array' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server chưa cấu hình API key' });

  try {
    const jpTexts = lines.map((l, i) => `${i + 1}. ${l.jp}`).join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: `Bạn là chuyên gia dịch tiếng Nhật sang tiếng Việt cho ứng dụng học shadowing.
Dịch tự nhiên, ngắn gọn, giữ sắc thái giao tiếp.
Trả về ĐÚNG định dạng JSON array, mỗi phần tử là chuỗi dịch tương ứng.
Không giải thích, không markdown, chỉ JSON thuần.`,
        messages: [{
          role: 'user',
          content: `Dịch ${lines.length} câu tiếng Nhật sau sang tiếng Việt.
Trả về JSON array với đúng ${lines.length} phần tử theo thứ tự.

${jpTexts}`
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Anthropic API error' });
    }

    const data = await response.json();
    let text = data.content?.[0]?.text || '';
    text = text.replace(/```json|```/g, '').trim();

    let translations;
    try {
      translations = JSON.parse(text);
    } catch {
      const m = text.match(/\[[\s\S]*\]/);
      if (m) translations = JSON.parse(m[0]);
      else return res.status(500).json({ error: 'Claude trả về định dạng không đúng' });
    }

    return res.status(200).json({ translations });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
