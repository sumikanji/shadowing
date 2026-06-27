export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, videoId, lines } = req.body;

  // ── FETCH CAPTIONS ────────────────────────────────────────────────────
  if (action === 'captions') {
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    try {
      const html = await fetchYoutubePage(videoId);
      
      const match = html.match(/"captionTracks":(\[.*?\])/);
      if (!match) return res.status(404).json({ error: 'Video này không có caption tự động. Hãy thử video khác hoặc nhập transcript thủ công.' });

      let tracks;
      try { tracks = JSON.parse(match[1]); }
      catch { return res.status(500).json({ error: 'Lỗi đọc danh sách caption' }); }

      console.log('Available tracks:', tracks.map(t => `${t.languageCode} (${t.kind})`));

      // Priority: manual JA > auto JA > any JA > first track
      const jaManual = tracks.find(t => (t.languageCode === 'ja' || t.languageCode === 'ja-JP') && t.kind !== 'asr');
      const jaAuto   = tracks.find(t => (t.languageCode === 'ja' || t.languageCode === 'ja-JP') && t.kind === 'asr');
      const jaAny    = tracks.find(t => t.languageCode?.startsWith('ja'));
      const track    = jaManual || jaAuto || jaAny || tracks[0];

      if (!track) return res.status(404).json({ error: 'Không tìm thấy caption tiếng Nhật' });

      // Fetch caption XML
      let captionUrl = track.baseUrl;
      // Request Japanese specifically and disable auto-translate
      if (!captionUrl.includes('tlang')) {
        captionUrl += '&fmt=json3';
      }

      const capRes = await fetch(captionUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!capRes.ok) throw new Error('Không tải được caption');
      
      const contentType = capRes.headers.get('content-type') || '';
      let rawLines = [];

      if (contentType.includes('json') || captionUrl.includes('fmt=json3')) {
        // JSON3 format
        try {
          const json = await capRes.json();
          for (const event of (json.events || [])) {
            if (!event.segs) continue;
            const t = (event.tStartMs || 0) / 1000;
            const jp = event.segs.map(s => s.utf8 || '').join('').replace(/\n/g,' ').trim();
            if (jp && jp !== '​') rawLines.push({ t, jp, vn: '' });
          }
        } catch {
          // fallback to XML
          const xml = await capRes.text();
          rawLines = parseXmlCaptions(xml);
        }
      } else {
        const xml = await capRes.text();
        rawLines = parseXmlCaptions(xml);
      }

      // Merge very short consecutive lines (< 1.5s apart)
      const merged = [];
      for (const line of rawLines) {
        const prev = merged[merged.length - 1];
        if (prev && line.t - prev.t < 1.5 && (prev.jp + line.jp).length < 40) {
          prev.jp += line.jp;
        } else {
          merged.push({ ...line });
        }
      }

      if (!merged.length) return res.status(404).json({ error: 'Caption trống hoặc không đọc được' });

      const trackName = track.name?.simpleText || (track.kind === 'asr' ? '自動生成' : track.languageCode);
      return res.status(200).json({ lines: merged, track: trackName, auto: track.kind === 'asr' });

    } catch (err) {
      console.error('Caption error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── TRANSLATE ─────────────────────────────────────────────────────────
  if (action === 'translate') {
    if (!lines || !Array.isArray(lines) || !lines.length)
      return res.status(400).json({ error: 'Missing lines' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Server chưa cấu hình ANTHROPIC_API_KEY' });

    try {
      // Split into batches of 80 lines to avoid token limit
      const BATCH = 80;
      const allTranslations = [];

      for (let i = 0; i < lines.length; i += BATCH) {
        const batch = lines.slice(i, i + BATCH);
        const jpTexts = batch.map((l, j) => `${j + 1}. ${l.jp}`).join('\n');

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
              content: `Dịch ${batch.length} câu tiếng Nhật sau sang tiếng Việt.
Trả về JSON array với đúng ${batch.length} phần tử theo thứ tự.

${jpTexts}`
            }]
          })
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error?.message || `Anthropic API error ${response.status}`);
        }

        const data = await response.json();
        let text = data.content?.[0]?.text || '';
        text = text.replace(/```json|```/g, '').trim();

        let translations;
        try { translations = JSON.parse(text); }
        catch {
          const m = text.match(/\[[\s\S]*\]/);
          if (m) translations = JSON.parse(m[0]);
          else throw new Error('Claude trả về định dạng không đúng');
        }

        allTranslations.push(...translations);
      }

      return res.status(200).json({ translations: allTranslations });

    } catch (err) {
      console.error('Translate error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}

// ── HELPERS ───────────────────────────────────────────────────────────
async function fetchYoutubePage(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml',
    }
  });
  if (!res.ok) throw new Error('Không tải được trang YouTube');
  return res.text();
}

function parseXmlCaptions(xml) {
  const lines = [];
  const regex = /<text start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const t = parseFloat(m[1]);
    const jp = m[2]
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/<[^>]+>/g,'').replace(/\n/g,' ').trim();
    if (jp) lines.push({ t, jp, vn: '' });
  }
  return lines;
}
