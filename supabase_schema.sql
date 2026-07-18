-- =========================================================
-- AQUAFIT SAINT AUBIN - Plateforme de remboursement des frais de piscine
-- Migration Supabase v1
-- =========================================================

-- ---------------------------------------------------------
-- 1. EXTENSIONS
-- ---------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------
-- 2. TABLE PROFILES (1 ligne par utilisateur auth.users)
-- ---------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  -- Coordonnées bancaires (accès restreint via RLS, cf. plus bas)
  iban text,
  bic text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'Adhérents AQUAFIT Saint Aubin : identité + coordonnées bancaires pour remboursement des frais de piscine';
comment on column public.profiles.iban is 'IBAN - donnée sensible, visible uniquement par le propriétaire et les admins (trésorière)';

-- ---------------------------------------------------------
-- 3. TABLE REIMBURSEMENT_REQUESTS
-- ---------------------------------------------------------
create table if not exists public.reimbursement_requests (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,

  -- Contexte de la demande
  activity_label text not null, -- ex: "Abonnement piscine - trimestre 1 2026"
  description text,

  -- Justificatif
  invoice_file_path text not null, -- chemin dans le bucket storage 'justificatifs'
  invoice_file_name text,

  -- Extraction IA (renseigné par la fonction Netlify après analyse)
  ai_extracted_amount numeric(10,2),
  ai_vendor text,
  ai_invoice_date date,
  ai_confidence text check (ai_confidence in ('high', 'medium', 'low')),
  ai_raw_response jsonb,

  -- Montant retenu (modifiable par l'admin, pré-rempli avec la valeur IA)
  confirmed_amount numeric(10,2),

  -- Montant réellement remboursé = LEAST(confirmed_amount, plafond)
  -- Plafond aligné avec la constante PLAFOND côté front (index.html) et la fonction Netlify.
  reimbursed_amount numeric(10,2) generated always as (
    least(coalesce(confirmed_amount, ai_extracted_amount, 0), 150)
  ) stored,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'paid')),

  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  admin_notes text,
  paid_at timestamptz
);
comment on column public.reimbursement_requests.reimbursed_amount is 'Montant plafonné à 150€ automatiquement calculé (ajuster la valeur ici si le plafond change)';

create index if not exists idx_reimb_member on public.reimbursement_requests(member_id);
create index if not exists idx_reimb_status on public.reimbursement_requests(status);

-- trigger updated_at sur profiles
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- Empêche un adhérent non-admin de modifier son propre rôle (élévation de privilège)
create or replace function public.prevent_self_role_change()
returns trigger
language plpgsql
security definer
as $$
begin
  -- auth.uid() est NULL quand la requête vient du SQL Editor / service role
  -- (accès direct à la base, déjà de confiance) : on ne bloque que les appels
  -- faits depuis l'appli par un utilisateur authentifié non-admin.
  if auth.uid() is not null and new.role is distinct from old.role then
    if not exists (
      select 1 from public.profiles where id = auth.uid() and role = 'admin'
    ) then
      raise exception 'Seul un admin peut modifier le role d''un adherent';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_self_role_change on public.profiles;
create trigger trg_prevent_self_role_change
before update on public.profiles
for each row execute function public.prevent_self_role_change();

-- ---------------------------------------------------------
-- 4. HELPER : suis-je admin ?
-- ---------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------------------------------------------------------
-- 5. RLS - PROFILES
-- ---------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
for select
using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
for update
using (id = auth.uid() or public.is_admin())
with check (
  id = auth.uid() or public.is_admin()
);

-- Seul un admin peut changer le rôle d'un adhérent (le insert initial se fait via trigger below)
-- (Contrôle applicatif : le front ne doit pas exposer le champ role aux non-admins)
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
for insert
with check (id = auth.uid());

-- ---------------------------------------------------------
-- 6. Auto-création du profil à l'inscription
-- ---------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, email, first_name, last_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    'member'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------
-- 7. RLS - REIMBURSEMENT_REQUESTS
-- ---------------------------------------------------------
alter table public.reimbursement_requests enable row level security;

drop policy if exists reimb_select on public.reimbursement_requests;
create policy reimb_select on public.reimbursement_requests
for select
using (member_id = auth.uid() or public.is_admin());

drop policy if exists reimb_insert on public.reimbursement_requests;
create policy reimb_insert on public.reimbursement_requests
for insert
with check (member_id = auth.uid());

-- L'adhérent peut modifier sa demande tant qu'elle est en attente ; l'admin peut tout modifier
drop policy if exists reimb_update on public.reimbursement_requests;
create policy reimb_update on public.reimbursement_requests
for update
using (
  (member_id = auth.uid() and status = 'pending')
  or public.is_admin()
)
with check (
  (member_id = auth.uid() and status = 'pending')
  or public.is_admin()
);

drop policy if exists reimb_delete on public.reimbursement_requests;
create policy reimb_delete on public.reimbursement_requests
for delete
using (
  (member_id = auth.uid() and status = 'pending')
  or public.is_admin()
);

-- ---------------------------------------------------------
-- 8. STORAGE - bucket privé 'justificatifs'
-- ---------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('justificatifs', 'justificatifs', false)
on conflict (id) do nothing;

-- Convention de chemin : {member_id}/{filename}
drop policy if exists justificatifs_insert on storage.objects;
create policy justificatifs_insert on storage.objects
for insert
with check (
  bucket_id = 'justificatifs'
  and (auth.uid())::text = (storage.foldername(name))[1]
);

drop policy if exists justificatifs_select on storage.objects;
create policy justificatifs_select on storage.objects
for select
using (
  bucket_id = 'justificatifs'
  and (
    (auth.uid())::text = (storage.foldername(name))[1]
    or public.is_admin()
  )
);

drop policy if exists justificatifs_delete on storage.objects;
create policy justificatifs_delete on storage.objects
for delete
using (
  bucket_id = 'justificatifs'
  and (
    (auth.uid())::text = (storage.foldername(name))[1]
    or public.is_admin()
  )
);

-- ---------------------------------------------------------
-- 9. Vue pratique pour l'export trésorière (virements)
-- ---------------------------------------------------------
create or replace view public.v_payments_to_process as
select
  r.id as request_id,
  p.first_name,
  p.last_name,
  p.iban,
  p.bic,
  r.activity_label,
  r.reimbursed_amount,
  r.status,
  r.reviewed_at
from public.reimbursement_requests r
join public.profiles p on p.id = r.member_id
where r.status = 'approved'
order by r.reviewed_at asc;

-- Note : cette vue hérite des policies de ses tables sous-jacentes (security_invoker par défaut sur PG15+ Supabase récent).
-- Vérifier que security_invoker = true est bien actif, sinon la recréer explicitement :
alter view public.v_payments_to_process set (security_invoker = true);

-- ---------------------------------------------------------
-- 10. Premier admin (à exécuter manuellement après ta 1ère inscription)
-- ---------------------------------------------------------
-- update public.profiles set role = 'admin' where email = 'tresoriere@example.com';
