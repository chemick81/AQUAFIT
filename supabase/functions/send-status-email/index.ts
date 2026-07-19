// supabase/functions/send-status-email/index.ts
//
// Envoie un email à l'adhérent quand la trésorière valide, refuse ou paie
// sa demande de remboursement.
//
// Migré depuis netlify/functions/send-status-email.js -> Supabase Edge Function.
//
// Fournisseur : Brevo (ex-Sendinblue) — offre gratuite (300 emails/jour),
// ne demande pas de configurer un domaine DNS.
//
// Secrets requis (à définir avec `supabase secrets set`) :
//   BREVO_API_KEY      -> clé API créée sur https://app.brevo.com (SMTP & API > API Keys)
//   BREVO_SENDER_EMAIL -> adresse expéditrice, validée dans Brevo
//   BREVO_SENDER_NAME  -> optionnel, ex. "AQUAFIT Saint Aubin"

const SENDER_NAME_DEFAULT = "AQUAFIT Saint Aubin";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface EmailParams {
  firstName?: string;
  activityLabel: string;
  amount?: number;
  adminNotes?: string;
}

function buildContent(
  status: string,
  { firstName, activityLabel, amount, adminNotes }: EmailParams,
) {
  const montant = typeof amount === "number"
    ? amount.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })
    : null;

  if (status === "approved") {
    return {
      subject: "Votre demande de remboursement AQUAFIT a été validée ✅",
      html: `
        <p>Bonjour ${firstName || ""},</p>
        <p>Ta demande de remboursement pour <strong>${activityLabel}</strong> a été <strong>validée</strong> par la trésorière.</p>
        ${montant ? `<p>Montant retenu : <strong>${montant}</strong></p>` : ""}
        ${adminNotes ? `<p>Note de la trésorière : <em>${adminNotes}</em></p>` : ""}
        <p>Le virement sera effectué prochainement ; tu recevras un nouvel email de confirmation une fois le paiement réalisé.</p>
        <p>— AQUAFIT Saint Aubin</p>
      `,
    };
  }

  if (status === "rejected") {
    return {
      subject: "Votre demande de remboursement AQUAFIT a été refusée",
      html: `
        <p>Bonjour ${firstName || ""},</p>
        <p>Ta demande de remboursement pour <strong>${activityLabel}</strong> a été <strong>refusée</strong> par la trésorière.</p>
        ${adminNotes ? `<p>Motif : <em>${adminNotes}</em></p>` : "<p>N'hésite pas à contacter la trésorière pour en savoir plus.</p>"}
        <p>— AQUAFIT Saint Aubin</p>
      `,
    };
  }

  if (status === "paid") {
    return {
      subject: "Remboursement AQUAFIT effectué 💶",
      html: `
        <p>Bonjour ${firstName || ""},</p>
        <p>Le virement correspondant à ta demande pour <strong>${activityLabel}</strong> a été effectué par la trésorière.</p>
        ${montant ? `<p>Montant viré : <strong>${montant}</strong></p>` : ""}
        <p>— AQUAFIT Saint Aubin</p>
      `,
    };
  }

  return null;
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

  const apiKey = Deno.env.get("BREVO_API_KEY");
  const senderEmail = Deno.env.get("BREVO_SENDER_EMAIL");
  const senderName = Deno.env.get("BREVO_SENDER_NAME") || SENDER_NAME_DEFAULT;

  // On ne casse jamais le flux de validation/refus/paiement côté trésorière
  // si l'email n'est pas configuré ou échoue : on renvoie juste un statut clair.
  if (!apiKey || !senderEmail) {
    return new Response(
      JSON.stringify({
        sent: false,
        error: "BREVO_API_KEY ou BREVO_SENDER_EMAIL manquant côté Supabase.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let payload: {
    toEmail?: string;
    firstName?: string;
    status?: string;
    activityLabel?: string;
    amount?: number;
    adminNotes?: string;
  };
  try {
    payload = await req.json();
  } catch (_e) {
    return new Response(
      JSON.stringify({ error: "Corps de requête invalide" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { toEmail, firstName, status, activityLabel, amount, adminNotes } = payload;

  if (!toEmail || !status || !activityLabel) {
    return new Response(
      JSON.stringify({ error: "toEmail, status et activityLabel sont requis" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const content = buildContent(status, { firstName, activityLabel, amount, adminNotes });
  if (!content) {
    // status inconnu (ex. 'pending') -> rien à envoyer, ce n'est pas une erreur
    return new Response(
      JSON.stringify({ sent: false, skipped: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: toEmail, name: firstName || undefined }],
        subject: content.subject,
        htmlContent: content.html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(
        JSON.stringify({ sent: false, error: `Brevo (${res.status})`, detail: errText }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ sent: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        sent: false,
        error: "Erreur serveur lors de l'envoi",
        detail: err instanceof Error ? err.message : String(err),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
