export async function POST(request) {
  const { prompt } = await request.json();

  if (!prompt) {
    return Response.json({ error: "No prompt provided" }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "API key not configured" }, { status: 500 });
  }

  const systemPrompt = `You are a graph axis generator for UK school mathematics.
Given a description of a graph, return ONLY a JSON object with these fields:
- xMin (number)
- xMax (number)  
- yMin (number)
- yMax (number)
- xLabel (string, single letter like "x" or "t", or empty)
- yLabel (string, single letter like "y" or "d", or empty)
- xSubLabel (string, axis description like "Time (minutes)", or empty)
- ySubLabel (string, axis description like "Distance (km)", or empty)
- title (string, a short graph title, or empty)
- explanation (string, one short sentence explaining your choices)

Rules:
- Choose clean, round numbers for min/max that extend slightly beyond the described range
- Prefer intervals of 1, 2, 5, 10, 20, 25, 50, 100
- For time axes starting at 0, always use 0 as xMin
- Return ONLY the JSON object, no markdown, no explanation outside the JSON`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\nGraph description: ${prompt}` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    console.error("Gemini error status:", response.status);
    console.error("Gemini error body:", err);
    return Response.json({ error: "Gemini API error", status: response.status, detail: err }, { status: 502 });
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  // Strip markdown fences if present
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean);
    return Response.json(parsed);
  } catch {
    return Response.json({ error: "Could not parse Gemini response", raw: text }, { status: 502 });
  }
}
