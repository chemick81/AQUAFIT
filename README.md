# AQUAFIT Saint Aubin — Plateforme de remboursement

Appli mono-fichier (même base que le club de golf GCSA) : `index.html` + une fonction Netlify pour la lecture IA des factures + une migration SQL Supabase.

Sert à rembourser les **frais de piscine / abonnements aquafit** des adhérents, sur présentation d'un justificatif, dans la limite d'un plafond (150 € par défaut — voir plus bas pour l'ajuster).

## 1. Supabase

1. Crée un projet sur https://supabase.com
2. SQL Editor → colle et exécute `supabase_schema.sql` en entier
3. Authentication → Providers → active **Email** (désactive "Confirm email" si tu veux tester vite, sinon garde-le activé en prod)
4. Storage → vérifie que le bucket `justificatifs` a bien été créé (privé) par le script
5. Project Settings → API → récupère `Project URL` et `anon public key`

## 2. index.html

Remplace en haut du fichier (section CONFIG) :

```js
const SUPABASE_URL = "https://TON-PROJET.supabase.co";
const SUPABASE_ANON_KEY = "ta-clé-anon";
```

## 3. Netlify

1. Crée un nouveau site, connecte ton repo GitHub `AQUAFIT`
2. Récupère une clé Gemini **gratuite** (aucune carte bancaire requise) :
   - Va sur https://aistudio.google.com
   - Connecte-toi avec un compte Google
   - Clique sur "Get API key" / "Créer une clé API" dans le menu de gauche
   - Copie la clé (commence par `AIza...`)
3. Site settings → Environment variables → ajoute :
   - `GEMINI_API_KEY` = la clé copiée ci-dessus
4. Deploy — Netlify détecte `netlify.toml` et déploie automatiquement la fonction `analyze-invoice`

> Le tier gratuit de Gemini (modèle `gemini-flash-latest`, l'alias du dernier Flash stable de Google) est largement suffisant pour le volume d'une petite association (quelques factures par semaine). Si un jour tu dépasses le quota gratuit, Google renvoie une erreur 429 — l'appli bascule alors automatiquement en saisie manuelle par la trésorière (rien ne casse).
>
> Google retire régulièrement ses anciens modèles (ex: `gemini-2.5-flash` a été retiré en 2026). En utilisant l'alias `gemini-flash-latest` dans `netlify/functions/analyze-invoice.js`, l'appli reste à jour automatiquement sans qu'il faille modifier le code. Si l'erreur "This model … is no longer available" réapparaît un jour, consulte https://ai.google.dev/gemini-api/docs/models pour le nom du modèle courant.

## 4bis. Emails de notification (validation / refus / paiement)

[#4bis-emails-de-notification-validation--refus--paiement](#4bis-emails-de-notification-validation--refus--paiement)

Quand la trésorière valide, refuse ou marque payée une demande, l'adhérent reçoit automatiquement un email. On utilise **Brevo** (ex-Sendinblue) : gratuit jusqu'à 300 emails/jour, et surtout — contrairement à d'autres fournisseurs — il ne demande **pas** de configurer un nom de domaine (DNS), juste de valider une seule adresse d'expéditeur.

1. Crée un compte gratuit sur <https://www.brevo.com>
2. Menu **Expéditeurs, domaines et dédiés** → **Expéditeurs** → ajoute l'adresse qui enverra les emails (ex. `tresorerie@aquafit-saintaubin.fr`, ou même une adresse Gmail) → tu reçois un email de confirmation, clique dessus
3. Menu **SMTP & API** → **Clés API** → crée une nouvelle clé API (v3), copie-la
4. Sur Netlify → Site settings → Environment variables → ajoute :
  - `BREVO_API_KEY` = la clé copiée à l'étape 3
  - `BREVO_SENDER_EMAIL` = l'adresse validée à l'étape 2
  - `BREVO_SENDER_NAME` = optionnel, ex. `AQUAFIT Saint Aubin` (sinon ce nom par défaut est utilisé)
5. Redéploie le site (Netlify redéploie automatiquement dès qu'une variable d'environnement change, ou déclenche un "Trigger deploy" manuel)

> Si la clé n'est pas configurée, l'appli continue de fonctionner normalement : la validation/refus/paiement se fait comme avant, seul l'email n'est pas envoyé (message dans la console navigateur, rien de bloquant pour la trésorière).

## 4. Premier admin (toi / la trésorière)

1. Inscris-toi normalement sur l'appli (bouton "Créer un compte")
2. Dans Supabase → SQL Editor, exécute :

```sql
update public.profiles set role = 'admin' where email = 'email-de-la-tresoriere@exemple.fr';
```

3. Reconnecte-toi : l'onglet "Espace trésorière" apparaît

## 5. Ajuster le plafond de remboursement

Le plafond est fixé à **150 €** par défaut, à 3 endroits qu'il faut garder synchronisés si tu veux le changer :

- `index.html` → `const PLAFOND = 150;`
- `netlify/functions/analyze-invoice.js` → `const PLAFOND = 150;`
- `supabase_schema.sql` → `least(coalesce(confirmed_amount, ai_extracted_amount, 0), 150)` dans la colonne générée `reimbursed_amount`

## 6. IBAN/BIC des adhérents

Le formulaire gère déjà la saisie de l'IBAN/BIC par l'adhérent lui-même, via l'onglet "Mon profil". La trésorière peut aussi les corriger depuis l'onglet "Adhérents".

## Comment ça marche (flux)

1. L'adhérent se connecte, dépose une facture (abonnement piscine, cotisation aquafit…) → la fonction Netlify appelle Gemini pour lire le montant, le fournisseur, la date
2. La demande est créée avec `status = pending` et le montant lu par l'IA
3. La trésorière (Espace trésorière) examine, peut corriger le montant, valide/refuse
4. Une fois validées, les demandes apparaissent dans l'export CSV "virements" (nom, IBAN, BIC, montant plafonné) prêt à donner à la banque
5. Une fois le virement fait, la trésorière marque la demande "Payé"

## Sécurité

- RLS active partout : un adhérent ne voit que ses propres demandes ; l'IBAN/BIC n'est lisible que par son propriétaire et les admins
- Le bucket `justificatifs` est privé, accès par URL signée temporaire uniquement
- La clé Gemini reste côté serveur (fonction Netlify), jamais exposée au navigateur
- Sous-traitants (hébergement / traitement de données) : Supabase (base de données + fichiers), Netlify (hébergement + fonctions), Google Gemini (lecture des factures), Brevo (envoi des emails de notification). Prénom, nom et email de l'adhérent transitent par Brevo pour l'envoi des emails ; aucune donnée bancaire (IBAN/BIC) n'y est envoyée.
