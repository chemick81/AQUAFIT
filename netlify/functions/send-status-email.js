// netlify/functions/send-status-email.js
//
// Envoie un email à l'adhérent quand la trésorière valide, refuse ou paie
// sa demande de remboursement.
//
// Fournisseur : Brevo (ex-Sendinblue) — choisi car son offre gratuite
// (300 emails/jour) ne demande PAS de configurer un domaine DNS : il suffit
// de valider une seule adresse d'expéditeur (ex. tresorerie@aquafit-saintaubin.fr
// ou même une adresse gmail) en quelques clics. Suffisant pour le volume
// d'une petite association.
//
// Variables d'environnement requises sur Netlify :
//   BREVO_API_KEY     -> clé API créée sur https://app.brevo.com (SMTP & API > API Keys)
//   BREVO_SENDER_EMAIL -> adresse expéditrice, validée dans Brevo (Senders, Domains & Dedicated IPs > Senders)
//   BREVO_SENDER_NAME  -> optionnel, ex. "AQUAFIT Saint Aubin" (défaut ci-dessous)
//
// Voir le README.md pour la procédure pas-à-pas.

const SENDER_NAME_DEFAULT = "AQUAFIT Saint Aubin";

function buildContent(status, { firstName, activityLabel, amount, adminNotes }) {
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée" }) };
  }

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || SENDER_NAME_DEFAULT;

  // On ne casse jamais le flux de validation/refus/paiement côté trésorière
  // si l'email n'est pas configuré ou échoue : on renvoie juste un statut clair.
  if (!apiKey || !senderEmail) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        sent: false,
        error: "BREVO_API_KEY ou BREVO_SENDER_EMAIL manquant côté Netlify.",
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Corps de requête invalide" }) };
  }

  const { toEmail, firstName, status, activityLabel, amount, adminNotes } = payload;

  if (!toEmail || !status || !activityLabel) {
    return { statusCode: 400, body: JSON.stringify({ error: "toEmail, status et activityLabel sont requis" }) };
  }

  const content = buildContent(status, { firstName, activityLabel, amount, adminNotes });
  if (!content) {
    // status inconnu (ex. 'pending') -> rien à envoyer, ce n'est pas une erreur
    return { statusCode: 200, body: JSON.stringify({ sent: false, skipped: true }) };
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
      return {
        statusCode: 200,
        body: JSON.stringify({ sent: false, error: `Brevo (${res.status})`, detail: errText }),
      };
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({ sent: false, error: "Erreur serveur lors de l'envoi", detail: err.message }),
    };
  }
};
