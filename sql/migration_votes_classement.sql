-- Le vote classe les trois répartitions par adresse : 1, puis 2, puis 3.

ALTER TABLE votes ADD COLUMN IF NOT EXISTS rang_2 INT;
ALTER TABLE votes ADD COLUMN IF NOT EXISTS rang_3 INT;

ALTER TABLE votes DROP CONSTRAINT IF EXISTS votes_classement;
ALTER TABLE votes ADD CONSTRAINT votes_classement CHECK (
    (rang_2 IS NULL AND rang_3 IS NULL)
    OR (
        choix_solution IN (4, 5, 6)
        AND rang_2 IN (4, 5, 6)
        AND rang_3 IN (4, 5, 6)
        AND choix_solution <> rang_2
        AND choix_solution <> rang_3
        AND rang_2 <> rang_3
    )
);
