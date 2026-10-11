-- Heure d'arrivée du trajet retenu, sans l'attente jusqu'à 9 h.

ALTER TABLE resultats_affectation ADD COLUMN IF NOT EXISTS arrivee TIME;
