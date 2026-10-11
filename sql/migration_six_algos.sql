-- À exécuter sur le projet déjà en ligne, une fois resultats_affectation et votes vides.
-- Remplace les deux colonnes de solution par une ligne par algorithme,
-- élargit le vote de 1 à 6, et ajoute la déclaration de voiture.

DO $$
BEGIN
    IF (SELECT count(*) FROM resultats_affectation) > 0
        OR (SELECT count(*) FROM votes) > 0 THEN
        RAISE EXCEPTION 'resultats_affectation ou votes ne sont pas vides';
    END IF;
END $$;

DROP TABLE resultats_affectation;

CREATE TABLE resultats_affectation (
    id SERIAL PRIMARY KEY,
    email_etudiant VARCHAR(255) NOT NULL REFERENCES etudiants_voeux (email),
    algo VARCHAR(32) NOT NULL CHECK (algo IN (
        'voeux_moyenne', 'voeux_pire', 'voeux_p90',
        'adresses_moyenne', 'adresses_pire', 'adresses_p90'
    )),
    magasin_id INT NOT NULL REFERENCES magasins (id),
    temps_min INT NOT NULL CHECK (temps_min >= 0),
    rang_voeu INT NOT NULL CHECK (rang_voeu >= 1),
    UNIQUE (email_etudiant, algo)
);

CREATE TRIGGER resultats_email_norm
    BEFORE INSERT OR UPDATE ON resultats_affectation
    FOR EACH ROW
    EXECUTE FUNCTION normaliser_email_etudiant();

ALTER TABLE resultats_affectation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lecture publique resultats"
    ON resultats_affectation FOR SELECT
    USING (true);

GRANT SELECT ON resultats_affectation TO anon, authenticated;

ALTER TABLE votes DROP CONSTRAINT IF EXISTS votes_choix_solution_check;
ALTER TABLE votes ADD CONSTRAINT votes_choix_solution_check CHECK (choix_solution BETWEEN 1 AND 6);

CREATE TABLE mobilite (
    email VARCHAR(255) PRIMARY KEY REFERENCES etudiants_voeux (email),
    a_voiture BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER mobilite_email_norm
    BEFORE INSERT OR UPDATE ON mobilite
    FOR EACH ROW
    EXECUTE FUNCTION normaliser_email();

ALTER TABLE mobilite ENABLE ROW LEVEL SECURITY;

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

GRANT SELECT, INSERT, UPDATE ON mobilite TO anon, authenticated;
