// api/fetch-scores.js
// Runs every 15 minutes via Vercel cron
// Fetches current Masters scores via Anthropic API and saves to Supabase

const PLAYERS = [
  'Scottie Scheffler','Min Woo Lee','Russell Henley','Patrick Cantlay','Adam Scott','Sam Burns',
  'Rory McIlroy','Chris Gotterup','Si Woo Kim','Jake Knapp','Jason Day','Aaron Rai',
  'Ludvig Åberg','Brooks Koepka','Collin Morikawa','Nico Hojgaard','Harris English','Rasmus Neergaard',
  'Bryson DeChambeau','Patrick Reed','Viktor Hovland','Shane Lowry','Daniel Burger','Max Homa',
  'Jon Rahm','Robert MacIntyre','Justin Thomas','Corey Conners','Sepp Straka','Keegan Bradley',
  'Tommy Fleetwood','Hideki Matsuyama','Sahith Bhatia','Jordan Spieth','Gary Woodland','Lanto Griffin',
  'Cam Young','Justin Rose','Tyrrell Hatton','Maverick McNealy','Marco Penge','Nico Echavarria',
  'Xander Schauffele','Matt Fitzpatrick','Ryan Fox','Brian Harman','Jacob Bridgeman','JJ Spaun',
];

export default async function handler(req, res) {
  // Allow manual trigger via GET, or scheduled cron
  try {
    // 1. Fetch scores from Anthropic with web search
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a golf score assistant. Return ONLY raw JSON — no markdown, no explanation, no backticks.',
        messages: [{
          role: 'user',
          content: `Search for the current 2026 Masters Tournament leaderboard scores right now.
Find round-by-round scores for these golfers: ${PLAYERS.join(', ')}.
Return ONLY a JSON object in this exact format (scores = strokes relative to par per round, null if not yet played):
{"players":{"Player Name":{"r1":-3,"r2":1,"r3":null,"r4":null}}}
Use player names exactly as provided. Omit players with no data.`
        }]
      })
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      throw new Error(`Anthropic API error: ${err}`);
    }

    const anthropicData = await anthropicRes.json();
    const textBlock = anthropicData.content?.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text response from Anthropic');

    const raw = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');

    const parsed = JSON.parse(match[0]);
    if (!parsed.players) throw new Error('Unexpected JSON format');

    // 2. Load current game state from Supabase
    const sbGetRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/game_state?id=eq.1&select=state`,
      {
        headers: {
          'apikey': process.env.SUPABASE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        }
      }
    );
    const sbData = await sbGetRes.json();
    const currentState = sbData[0]?.state || { scores: {}, madeCut: {}, cutSet: false, dayHigh: { 3: null, 4: null } };

    // 3. Merge new scores into state
    let updatedCount = 0;
    Object.entries(parsed.players).forEach(([name, rounds]) => {
      if (!currentState.scores[name]) currentState.scores[name] = {};
      [1, 2, 3, 4].forEach(r => {
        const v = rounds[`r${r}`];
        if (v !== null && v !== undefined) {
          currentState.scores[name][r] = v;
          updatedCount++;
        }
      });
    });

    // 4. Auto-compute day high scores for cut penalty
    [3, 4].forEach(r => {
      if (currentState.dayHigh[r] !== null && currentState.dayHigh[r] !== undefined) return;
      const rScores = PLAYERS
        .map(n => currentState.scores[n]?.[r])
        .filter(s => s !== null && s !== undefined);
      if (rScores.length) currentState.dayHigh[r] = Math.max(...rScores);
    });

    // 5. Save updated state back to Supabase
    const sbPutRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/game_state?id=eq.1`,
      {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          state: currentState,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!sbPutRes.ok) {
      const err = await sbPutRes.text();
      throw new Error(`Supabase write error: ${err}`);
    }

    console.log(`✓ Updated ${Object.keys(parsed.players).length} players, ${updatedCount} score entries`);
    res.status(200).json({
      ok: true,
      players: Object.keys(parsed.players).length,
      scores: updatedCount,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('fetch-scores error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}
