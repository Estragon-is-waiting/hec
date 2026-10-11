# Vœux de stage Darty

Les étudiants saisissent leur adresse en Île-de-France .

## 1. Créer les tables

Dans le SQL Editor Supabase, exécuter [sql/schema.sql](sql/schema.sql) une seule fois, sur une base vide.

La clé anonyme peut lire les magasins, les résultats et les votes, et insérer un vœu ou un vote. Elle ne peut pas lire les adresses. Les scripts Python utilisent la clé **service role**.

## 2. Importer les 47 magasins

```bash
cd algo
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Renseigner dans `algo/.env` :

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `IDFM_API_KEY` (jeton PRIM Île-de-France Mobilités, utilisé à l’étape 4)

Puis :

```bash
python import_magasins.py data/magasins.xlsx
```

Le classeur est le listing Darty (feuille `listing mag`), avec la colonne Adresse. Un magasin noté 1 accueille exactement un étudiant. Un magasin noté 2 en accueille entre 2 et 4. L’adresse du fichier est conservée ; la BAN sert seulement à en tirer la latitude et la longitude. Relancer la commande met à jour les magasins déjà présents (adresse et coordonnées).

`--dry-run` géocode et affiche le résultat sans écrire dans Supabase.

## 3. Lancer le site

En local, copier la configuration puis servir les fichiers :

```bash
cp config.example.js config.js
python3 -m http.server 8000
```

Renseigner l’URL du projet et la clé anonyme dans `config.js`. Ouvrir `http://localhost:8000`.

Sur Vercel, le build `node scripts/write-config.js` produit `config.js` à partir des variables `SUPABASE_URL` et `SUPABASE_ANON_KEY`. Ne pas y mettre la service role ni la clé PRIM.

## 4. Fermer la saisie et calculer

Quand les vœux sont complets (120 étant l’effectif prévu) :

```sql
UPDATE app_config SET phase = 'calcul', updated_at = now() WHERE id = 1;
```

Puis, depuis `algo/` avec le venv activé :

```bash
python run_affectation.py
python run_affectation.py --publier
```

Avant le calcul, chaque étudiant peut indiquer s’il a une voiture (défaut : non), tant que la phase est `saisie`. Avec une voiture, le temps vers un magasin est le plus court entre l’itinéraire routier (OSRM) et les transports.

La commande lit le cache Google (`algo/cache/temps_google.json`), aux coordonnées du classeur `adresses_google.xlsx`. Les durées Navitia ne sont pas utilisées. Elle résout ensuite l'affectation :

- Famille vœux : d’abord le meilleur profil de rangs (pire rang, puis le nombre d’étudiants à ce rang, et ainsi de suite), puis le temps.
- Famille adresses : le temps seul, sans regarder les vœux.

Dans chaque famille : minimiser le temps moyen ; minimiser le pire trajet puis la moyenne ; minimiser le 90e percentile puis la moyenne. Un magasin peut rester vide. S’il reçoit des étudiants, il reste dans sa capacité. Chaque zone DIF en reçoit au moins 20. `--publier` passe la phase à `vote`. Les étudiants voient les six cartes et votent pour l’une d’elles.

`python run_affectation.py --self-test` vérifie le solveur sur un jeu fictif, sans Supabase ni Navitia. Le modèle est écrit avec PuLP. Sur Apple Silicon, le CBC inclus dans PuLP est un binaire x86 inutilisable : le script utilise alors HiGHS (`highspy`).

## 5. Clore le vote

```sql
UPDATE app_config SET phase = 'clos', updated_at = now() WHERE id = 1;
```

Les étudiants peuvent encore consulter leur affectation. Les boutons de vote disparaissent.
