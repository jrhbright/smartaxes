export async function POST(request) {
  try {
    const { prompt } = await request.json();

    if (!prompt) {
      return Response.json({ error: "No prompt provided" }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is not set");
      return Response.json({ error: "API key not configured" }, { status: 500 });
    }

    console.log("Calling Gemini with prompt:", prompt.slice(0, 100));

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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nGraph description: ${prompt}` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
        }),
      }
    );

    console.log("Gemini response status:", response.status);

    if (!response.ok) {
      const err = await response.text();
      console.error("Gemini error body:", err);
      return Response.json({ error: "Gemini API error", status: response.status, detail: err }, { status: 502 });
    }

    const data = await response.json();
    console.log("Gemini raw data:", JSON.stringify(data).slice(0, 300));

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    console.log("Extracted text:", text.slice(0, 200));

    const clean = text.replace(/```json|```/g, "").trim();

    try {
      const parsed = JSON.parse(clean);
      return Response.json(parsed);
    } catch (parseErr) {
      console.error("JSON parse failed:", parseErr.message, "raw text:", text);
      return Response.json({ error: "Could not parse Gemini response", raw: text }, { status: 502 });
    }
  } catch (outerErr) {
    console.error("Outer error:", outerErr.message);
    return Response.json({ error: outerErr.message }, { status: 500 });
  }
}
