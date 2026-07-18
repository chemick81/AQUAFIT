// netlify/functions/analyze-invoice.js
//
// Lit une facture (PDF ou image, en base64) avec l'API Gemini et en extrait
// le montant, le fournisseur et la date, pour préremplir la demande de
// remboursement des frais de piscine sur AQUAFIT Saint Aubin.
//
// Variable d'environnement requise sur Netlify : GEMINI_API_KEY
// (clé gratuite sur https://aistudio.google.com — voir README.md)

const PLAFOND = 150; // Doit rester aligné avec PLAFOND dans index.html et supabase_schema.sql

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée" }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        error: "GEMINI_API_KEY manquante",
        detail: "Ajoute la variable d'environnement GEMINI_API_KEY dans les paramètres du site Netlify.",
        amount: null,
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Corps de requête invalide" }) };
  }

  const { base64Data, mediaType } = payload;
  if (!base64Data || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: "Fichier manquant (base64Data / mediaType requis)" }) };
  }

  const prompt = `Tu analyses un justificatif (facture ou reçu) lié à une activité d'aquafit / piscine pour une association sportive.
Réponds UNIQUEMENT avec un objet JSON valide (aucun texte avant/après, aucun bloc markdown), au format exact suivant :
{
  "amount": <nombre ou null>,       // montant total TTC de la facture, en euros
  "vendor": <chaîne ou null>,       // nom du fournisseur / piscine / centre aquatique
  "invoice_date": <"AAAA-MM-JJ" ou null>,
  "confidence": "high" | "medium" | "low",
  "notes": <chaîne ou null>         // précision courte si le montant est incertain ou introuvable
}
Si tu ne trouves pas de montant clair, mets "amount": null et explique brièvement dans "notes".`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mediaType, data: base64Data } },
              ],
            },
          ],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return {
        statusCode: 200,
        body: JSON.stringify({
          error: `Erreur Gemini (${geminiRes.status})`,
          detail: errText,
          amount: null,
        }),
      };
    }

    const geminiJson = await geminiRes.json();
    const rawText =
      geminiJson?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

    let parsed;
    try {
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          error: "Réponse IA illisible",
          detail: rawText.slice(0, 300),
          amount: null,
        }),
      };
    }

    const amount = typeof parsed.amount === "number" ? parsed.amount : null;
    const reimbursed_amount = amount != null ? Math.min(amount, PLAFOND) : null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        amount,
        vendor: parsed.vendor ?? null,
        invoice_date: parsed.invoice_date ?? null,
        confidence: parsed.confidence ?? "low",
        notes: parsed.notes ?? null,
        reimbursed_amount,
      }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        error: "Erreur serveur lors de l'analyse",
        detail: err.message,
        amount: null,
      }),
    };
  }
};
