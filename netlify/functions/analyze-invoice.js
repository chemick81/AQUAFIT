// netlify/functions/analyze-invoice.js
//
// Lit une facture (PDF ou image, en base64) avec l'API Gemini et en extrait
// le montant, le fournisseur et la date, pour préremplir la demande de
// remboursement des frais de piscine sur AQUAFIT Saint Aubin.
//
// Variable d'environnement requise sur Netlify : GEMINI_API_KEY
// (clé gratuite sur https://aistudio.google.com — voir README.md)
//
// Modèle : "gemini-flash-latest" est un alias que Google fait pointer vers
// son dernier modèle Flash stable (actuellement Gemini 3.5 Flash). Google
// retire régulièrement les anciens modèles (ex: gemini-2.5-flash, retiré
// mi-2026) ; utiliser l'alias "-latest" évite d'avoir à changer ce fichier
// à chaque dépréciation. Si besoin de figer une version précise, voir la
// liste à jour ici : https://ai.google.dev/gemini-api/docs/models

// Le plafond n'est plus figé en dur : il est lu dans la table Supabase
// `settings` (clé 'plafond_remboursement'), modifiable par l'admin/trésorier
// depuis l'appli. PLAFOND_FALLBACK ne sert que si cette lecture échoue
// (ex. Supabase indisponible) — ça reste purement indicatif : le montant
// réellement remboursé est de toute façon recalculé côté base par le
// trigger `compute_reimbursed_amount` au moment de l'enregistrement.
const PLAFOND_FALLBACK = 150;

// Mêmes valeurs publiques que dans index.html (clé anon = faite pour être
// exposée côté client, ce n'est pas un secret).
const SUPABASE_URL = "https://nesfcrrwbwjorplokjwu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5lc2ZjcnJ3Yndqb3JwbG9rand1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTU3MDcsImV4cCI6MjA5OTk3MTcwN30.KUZAhiXeqWc6w7G0XPZK4iuaAjaJd5bT-QKjBwUHSCA";

async function fetchPlafond() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?key=eq.plafond_remboursement&select=value_numeric`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      }
    );
    if (!res.ok) return PLAFOND_FALLBACK;
    const rows = await res.json();
    const value = rows?.[0]?.value_numeric;
    return typeof value === "number" ? value : PLAFOND_FALLBACK;
  } catch (e) {
    return PLAFOND_FALLBACK;
  }
}

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
    const [geminiRes, plafond] = await Promise.all([
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
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
      ),
      fetchPlafond(),
    ]);

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
    // Indicatif uniquement : le montant réellement remboursé est recalculé
    // côté base (trigger compute_reimbursed_amount) au moment de l'insertion.
    const reimbursed_amount = amount != null ? Math.min(amount, plafond) : null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        amount,
        vendor: parsed.vendor ?? null,
        invoice_date: parsed.invoice_date ?? null,
        confidence: parsed.confidence ?? "low",
        notes: parsed.notes ?? null,
        reimbursed_amount,
        plafond,
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
