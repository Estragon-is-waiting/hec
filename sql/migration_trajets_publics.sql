-- Départs vers chaque magasin, lisibles sans identité.

CREATE TABLE trajets_publics (
    id SERIAL PRIMARY KEY,
    magasin_id INT NOT NULL REFERENCES magasins (id),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    temps_min INT NOT NULL CHECK (temps_min >= 0),
    mode TEXT NOT NULL CHECK (mode IN ('train', 'voiture'))
);

ALTER TABLE trajets_publics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lecture publique trajets"
    ON trajets_publics FOR SELECT
    USING (true);

GRANT SELECT ON trajets_publics TO anon, authenticated;
