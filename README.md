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

> Le tier gratuit de Gemini (modèle `gemini-2.5-flash`) est largement suffisant pour le volume d'une petite association (quelques factures par semaine). Si un jour tu dépasses le quota gratuit, Google renvoie une erreur 429 — l'appli bascule alors automatiquement en saisie manuelle par la trésorière (rien ne casse).

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
