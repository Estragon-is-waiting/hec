-- Les magasins prévus pour 1 étudiant peuvent en accueillir 1 ou 2.

ALTER TABLE magasins DROP CONSTRAINT capacite_selon_reference;

UPDATE magasins
SET capacite_max = 2
WHERE nb_etudiants_ref = 1;

ALTER TABLE magasins ADD CONSTRAINT capacite_selon_reference CHECK (
    (nb_etudiants_ref = 1 AND capacite_min = 1 AND capacite_max = 2)
    OR
    (nb_etudiants_ref = 2 AND capacite_min = 2 AND capacite_max = 4)
);
