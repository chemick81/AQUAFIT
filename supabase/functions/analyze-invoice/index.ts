// supabase/functions/analyze-invoice/index.ts
//
// Lit une facture (PDF ou image, en base64) avec l'API Gemini et en extrait
// le montant, le fournisseur et la date, pour préremplir la demande de
// remboursement des frais de piscine sur AQUAFIT Saint Aubin.
//
// Migré depuis netlify/functions/analyze-invoice.js -> Supabase Edge Function.
//
// Secret requis (à définir avec `supabase secrets set`) : GEMINI_API_KEY
// (clé gratuite sur https://aistudio.google.com — voir README.md)
//
// Modèle : "gemini-flash-latest" est un alias que Google fait pointer vers
// son dernier modèle Flash stable. Google retire régulièrement les anciens
// modèles ; utiliser l'alias "-latest" évite d'avoir à changer ce fichier
// à chaque dépréciation. Si besoin de figer une version précise, voir la
// liste à jour ici : https://ai.google.dev/gemini-api/docs/models

const PLAFOND_FALLBACK = 150;

// Mêmes valeurs publiques que dans index.html (clé anon = faite pour être
// exposée côté client, ce n'est pas un secret).
const SUPABASE_URL = "https://nesfcrrwbwjorplokjwu.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5lc2ZjcnJ3Yndqb3JwbG9rand1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTU3MDcsImV4cCI6MjA5OTk3MTcwN30.KUZAhiXeqWc6w7G0XPZK4iuaAjaJd5bT-QKjBwUHSCA";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function fetchPlafond(): Promise<number> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?key=eq.plafond_remboursement&select=value_numeric`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      },
    );
    if (!res.ok) return PLAFOND_FALLBACK;
    const rows = await res.json();
    const value = rows?.[0]?.value_numeric;
    return typeof value === "number" ? value : PLAFOND_FALLBACK;
  } catch (_e) {
    return PLAFOND_FALLBACK;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Méthode non autorisée" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: "GEMINI_API_KEY manquante",
        detail: "Ajoute le secret GEMINI_API_KEY avec `supabase secrets set`.",
        amount: null,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let payload: { base64Data?: string; mediaType?: string };
  try {
    payload = await req.json();
  } catch (_e) {
    return new Response(
      JSON.stringify({ error: "Corps de requête invalide" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { base64Data, mediaType } = payload;
  if (!base64Data || !mediaType) {
    return new Response(
      JSON.stringify({ error: "Fichier manquant (base64Data / mediaType requis)" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
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
        },
      ),
      fetchPlafond(),
    ]);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(
        JSON.stringify({
          error: `Erreur Gemini (${geminiRes.status})`,
          detail: errText,
          amount: null,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const geminiJson = await geminiRes.json();
    const rawText =
      geminiJson?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("") || "";

    let parsed: {
      amount?: number;
      vendor?: string;
      invoice_date?: string;
      confidence?: string;
      notes?: string;
    };
    try {
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (_parseErr) {
      return new Response(
        JSON.stringify({
          error: "Réponse IA illisible",
          detail: rawText.slice(0, 300),
          amount: null,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const amount = typeof parsed.amount === "number" ? parsed.amount : null;
    // Indicatif uniquement : le montant réellement remboursé est recalculé
    // côté base (trigger compute_reimbursed_amount) au moment de l'insertion.
    const reimbursed_amount = amount != null ? Math.min(amount, plafond) : null;

    return new Response(
      JSON.stringify({
        amount,
        vendor: parsed.vendor ?? null,
        invoice_date: parsed.invoice_date ?? null,
        confidence: parsed.confidence ?? "low",
        notes: parsed.notes ?? null,
        reimbursed_amount,
        plafond,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Erreur serveur lors de l'analyse",
        detail: err instanceof Error ? err.message : String(err),
        amount: null,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
