-- Schéma à exécuter une fois dans le SQL Editor Supabase, sur une base vide.
-- gen_random_uuid() est dans le cœur de PostgreSQL 13+. pgcrypto reste activé
-- pour les projets qui s'appuient encore dessus.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Dix identifiants de magasins, entiers et distincts, dans l'ordre des vœux.
CREATE OR REPLACE FUNCTION voeux_dix_distincts(v JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    elem JSONB;
    vu INT[] := ARRAY[]::INT[];
    n INT;
BEGIN
    IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v) <> 10 THEN
        RETURN FALSE;
    END IF;
    FOR elem IN SELECT value FROM jsonb_array_elements(v) AS t(value)
    LOOP
        IF jsonb_typeof(elem) IS DISTINCT FROM 'number' THEN
            RETURN FALSE;
        END IF;
        IF (elem #>> '{}') !~ '^[0-9]+$' THEN
            RETURN FALSE;
        END IF;
        n := (elem #>> '{}')::INT;
        IF n = ANY (vu) THEN
            RETURN FALSE;
        END IF;
        vu := vu || n;
    END LOOP;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION normaliser_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.email := lower(btrim(NEW.email));
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION normaliser_email_etudiant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.email_etudiant := lower(btrim(NEW.email_etudiant));
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Magasins Darty
-- La zone DIF ne sert qu'aux algorithmes d'affectation.
-- nb_etudiants_ref = 1 → 1 ou 2 étudiants
-- nb_etudiants_ref = 2 → entre 2 et 4 étudiants
-- ---------------------------------------------------------------------------

CREATE TABLE magasins (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(255) NOT NULL,
    code_ncg VARCHAR(20) NOT NULL UNIQUE,
    zone VARCHAR(10) NOT NULL CHECK (zone IN ('DIF01', 'DIF02', 'DIF03', 'DIF04')),
    code_postal VARCHAR(5) NOT NULL,
    ville VARCHAR(255) NOT NULL,
    adresse TEXT NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    capacite_min INT NOT NULL,
    capacite_max INT NOT NULL,
    nb_etudiants_ref INT NOT NULL,
    CONSTRAINT capacite_coherente CHECK (capacite_min >= 1 AND capacite_max >= capacite_min),
    CONSTRAINT capacite_selon_reference CHECK (
        (nb_etudiants_ref = 1 AND capacite_min = 1 AND capacite_max = 2)
        OR
        (nb_etudiants_ref = 2 AND capacite_min = 2 AND capacite_max = 4)
    )
);

-- ---------------------------------------------------------------------------
-- Vœux des étudiants. L'adresse n'est pas lisible par la clé anonyme.
-- ---------------------------------------------------------------------------

CREATE TABLE etudiants_voeux (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    nom VARCHAR(100) NOT NULL,
    prenom VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    adresse_exacte TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    voeux JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT identite_non_vide CHECK (
        char_length(btrim(nom)) > 0 AND char_length(btrim(prenom)) > 0
    ),
    CONSTRAINT email_format CHECK (email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
    CONSTRAINT voeux_dix CHECK (voeux_dix_distincts(voeux))
);

CREATE TRIGGER etudiants_email_norm
    BEFORE INSERT OR UPDATE ON etudiants_voeux
    FOR EACH ROW
    EXECUTE FUNCTION normaliser_email();

-- Une ligne par étudiant et par algorithme (1 à 6).
CREATE TABLE resultats_affectation (
    id SERIAL PRIMARY KEY,
    email_etudiant VARCHAR(255) NOT NULL REFERENCES etudiants_voeux (email),
    algo VARCHAR(32) NOT NULL CHECK (algo IN (
        'voeux_moyenne', 'voeux_pire', 'voeux_p90',
        'adresses_moyenne', 'adresses_pire', 'adresses_p90'
    )),
    magasin_id INT NOT NULL REFERENCES magasins (id),
    temps_min INT NOT NULL CHECK (temps_min >= 0),
    arrivee TIME,
    rang_voeu INT NOT NULL CHECK (rang_voeu >= 1),
    UNIQUE (email_etudiant, algo)
);

CREATE TRIGGER resultats_email_norm
    BEFORE INSERT OR UPDATE ON resultats_affectation
    FOR EACH ROW
    EXECUTE FUNCTION normaliser_email_etudiant();

CREATE TABLE votes (
    id SERIAL PRIMARY KEY,
    email_etudiant VARCHAR(255) NOT NULL UNIQUE REFERENCES etudiants_voeux (email),
    choix_solution INT NOT NULL CHECK (choix_solution BETWEEN 1 AND 6),
    rang_2 INT,
    rang_3 INT,
    voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT votes_classement CHECK (
        (rang_2 IS NULL AND rang_3 IS NULL)
        OR (
            choix_solution IN (4, 5, 6)
            AND rang_2 IN (4, 5, 6)
            AND rang_3 IN (4, 5, 6)
            AND choix_solution <> rang_2
            AND choix_solution <> rang_3
            AND rang_2 <> rang_3
        )
    )
);

CREATE TRIGGER votes_email_norm
    BEFORE INSERT OR UPDATE ON votes
    FOR EACH ROW
    EXECUTE FUNCTION normaliser_email_etudiant();

-- Voiture déclarée après les vœux. Défaut : pas de voiture.
CREATE TABLE mobilite (
    email VARCHAR(255) PRIMARY KEY REFERENCES etudiants_voeux (email),
    a_voiture BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER mobilite_email_norm
    BEFORE INSERT OR UPDATE ON mobilite
    FOR EACH ROW
    EXECUTE FUNCTION normaliser_email();

CREATE TABLE app_config (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    phase TEXT NOT NULL DEFAULT 'saisie' CHECK (phase IN ('saisie', 'calcul', 'vote', 'clos')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_config (id, phase) VALUES (1, 'saisie');

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE magasins ENABLE ROW LEVEL SECURITY;
ALTER TABLE etudiants_voeux ENABLE ROW LEVEL SECURITY;
ALTER TABLE resultats_affectation ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobilite ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lecture publique magasins"
    ON magasins FOR SELECT
    USING (true);

CREATE POLICY "Insertion publique voeux"
    ON etudiants_voeux FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Lecture publique resultats"
    ON resultats_affectation FOR SELECT
    USING (true);

CREATE POLICY "Lecture publique mobilite"
    ON mobilite FOR SELECT
    USING (true);

CREATE POLICY "Insertion mobilite"
    ON mobilite FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Mise a jour mobilite"
    ON mobilite FOR UPDATE
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Lecture publique votes"
    ON votes FOR SELECT
    USING (true);

CREATE POLICY "Insertion votes"
    ON votes FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Mise a jour votes"
    ON votes FOR UPDATE
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Lecture publique config"
    ON app_config FOR SELECT
    USING (true);

-- Maisons de départ : prénom, nom et point, sans la rue.
CREATE TABLE maisons (
    id SERIAL PRIMARY KEY,
    prenom TEXT NOT NULL,
    nom TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    CONSTRAINT maison_identite_non_vide CHECK (
        char_length(btrim(prenom)) > 0 AND char_length(btrim(nom)) > 0
    )
);

-- Départs vers un magasin : qui part, d'où, en combien de temps, train ou voiture.
CREATE TABLE trajets_publics (
    id SERIAL PRIMARY KEY,
    magasin_id INT NOT NULL REFERENCES magasins (id),
    maison_id INT REFERENCES maisons (id),
    prenom TEXT,
    nom TEXT,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    temps_min INT NOT NULL CHECK (temps_min >= 0),
    mode TEXT NOT NULL CHECK (mode IN ('train', 'voiture'))
);

ALTER TABLE maisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE trajets_publics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lecture publique maisons"
    ON maisons FOR SELECT
    USING (true);

CREATE POLICY "Lecture publique trajets"
    ON trajets_publics FOR SELECT
    USING (true);

GRANT SELECT ON maisons TO anon, authenticated;
GRANT SELECT ON trajets_publics TO anon, authenticated;

-- La clé anonyme ne lit pas etudiants_voeux : les adresses restent privées.
-- Les écritures de resultats_affectation passent par la service role.

GRANT SELECT ON magasins TO anon, authenticated;
GRANT INSERT ON etudiants_voeux TO anon, authenticated;
GRANT SELECT ON resultats_affectation TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON mobilite TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON votes TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE votes_id_seq TO anon, authenticated;
GRANT SELECT ON app_config TO anon, authenticated;
