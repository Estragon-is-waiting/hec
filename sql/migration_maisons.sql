-- Nom de la personne sur chaque départ, et une maison cliquable sans la rue.

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

ALTER TABLE trajets_publics
    ADD COLUMN maison_id INT REFERENCES maisons (id),
    ADD COLUMN prenom TEXT,
    ADD COLUMN nom TEXT;

ALTER TABLE maisons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lecture publique maisons"
    ON maisons FOR SELECT
    USING (true);

GRANT SELECT ON maisons TO anon, authenticated;
