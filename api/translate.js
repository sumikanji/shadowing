export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, videoId, lines } = req.body;

  // ── ACTION: fetch captions from YouTube (server-side, no CORS issue) ──
  if (action === 'captions') {
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    try {
      // Fetch YouTube page
      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          'Accept-Language': 'ja,en;q=0.9',
        }
      });
      if (!pageRes.ok) throw new Error('Không tải được trang YouTube');
      const html = await pageRes.text();

      // Extract caption tracks
      const match = html.match(/"captionTracks":(\[.*?\])/);
      if (!match) return res.status(404).json({ error: 'Video này không có caption / phụ đề' });

      let tracks;
      try { tracks = JSON.parse(match[1]); }
      catch { return res.status(500).json({ error: 'Lỗi đọc danh sách caption' }); }

      // Find Japanese track
      const jaTrack = tracks.find(t => t.languageCode === 'ja')
        || tracks.find(t => t.languageCode === 'ja-JP')
        || tracks.find(t => t.kind === 'asr' && t.languageCode === 'ja')
        || tracks[0];

      if (!jaTrack) return res.status(404).json({ error: 'Không tìm thấy caption tiếng Nhật' });

      // Fetch caption XML
      const capRes = await fetch(jaTrack.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!capRes.ok) throw new Error('Không tải được caption XML');
      const xml = await capRes.text();

      // Parse XML manually (no DOM on server)
      const rawLines = [];
      const regex = /<text start="([^"]+)"[^>]*>([^<]*)<\/text>/g;
      let m;
      while ((m = regex.exec(xml)) !== null) {
        const t = parseFloat(m[1]);
        const jp = m[2]
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
          .replace(/<[^>]+>/g,'').trim();
        if (jp) rawLines.push({ t, jp, vn: '' });
      }

      if (!rawLines.length) return res.status(404).json({ error: 'Caption trống hoặc không đọc được' });

      return res.status(200).json({ lines: rawLines, track: jaTrack.name?.simpleText || jaTrack.languageCode });

    } catch (err) {
      console.error('Caption error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ACTION: translate with Claude ────────────────────────────────────
  if (action === 'translate') {
    if (!lines || !Array.isArray(lines) || !lines.length)
      return res.status(400).json({ error: 'Missing lines' });

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
Dịch tự nhiên, ngắn gọn, giữ sắc thái giao tiếp và kính ngữ.
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
      try { translations = JSON.parse(text); }
      catch {
        const m = text.match(/\[[\s\S]*\]/);
        if (m) translations = JSON.parse(m[0]);
        else return res.status(500).json({ error: 'Claude trả về định dạng không đúng' });
      }

      return res.status(200).json({ translations });

    } catch (err) {
      console.error('Translate error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
