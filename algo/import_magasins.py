#!/usr/bin/env python3
"""Importe le listing Excel des magasins Darty dans Supabase.

Capacités :
  1 → exactement un étudiant
  2 → entre 2 et 4 étudiants

La colonne Adresse du classeur est conservée telle quelle.
Ses coordonnées sont obtenues via la BAN, pour la carte et les temps de trajet.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL")

import requests
from dotenv import load_dotenv
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent
CACHE_PATH = ROOT / "cache" / "geocodes.json"
BAN_URL = "https://api-adresse.data.gouv.fr/search/"
ZONES = {"DIF01", "DIF02", "DIF03", "DIF04"}


def cell_str(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    return str(value).strip()


def column_index(headers: list[str], label: str, predicate) -> int:
    for index, header in enumerate(headers):
        if predicate(header):
            return index
    raise SystemExit(f"Colonne introuvable dans le classeur : {label}. En-têtes lus : {headers}")


def load_stores(path: Path) -> list[dict]:
    workbook = load_workbook(path, data_only=False, read_only=True)
    sheet = None
    for name in workbook.sheetnames:
        if name.strip().casefold().startswith("listing"):
            sheet = workbook[name]
            break
    if sheet is None:
        raise SystemExit(f"Aucune feuille « listing » dans {path.name}.")

    rows = sheet.iter_rows(values_only=True)
    try:
        header_row = next(rows)
    except StopIteration:
        raise SystemExit("Le classeur est vide.")

    headers = [cell_str(value).casefold() for value in header_row]
    i_nom = column_index(headers, "Magasins", lambda h: h == "magasins")
    i_ncg = column_index(headers, "N°NCG", lambda h: "ncg" in h)
    i_zone = column_index(headers, "Zone DV", lambda h: "zone" in h)
    i_cp = column_index(headers, "Code Postal", lambda h: "code postal" in h)
    i_ville = column_index(headers, "Ville", lambda h: h == "ville")
    i_adresse = column_index(headers, "Adresse", lambda h: h == "adresse")
    i_nb = column_index(headers, "nb d'étudiants par magasin", lambda h: "par magasin" in h)

    stores = []
    seen = set()
    for row_number, row in enumerate(rows, start=2):
        nom = cell_str(row[i_nom] if i_nom < len(row) else None)
        if not nom:
            continue
        code = cell_str(row[i_ncg] if i_ncg < len(row) else None)
        zone = cell_str(row[i_zone] if i_zone < len(row) else None).upper()
        cp_raw = cell_str(row[i_cp] if i_cp < len(row) else None)
        ville = cell_str(row[i_ville] if i_ville < len(row) else None)
        adresse = cell_str(row[i_adresse] if i_adresse < len(row) else None)
        nb_raw = cell_str(row[i_nb] if i_nb < len(row) else None)
        if not adresse:
            raise SystemExit(f"Ligne {row_number} ({nom}) : adresse manquante.")

        if not code or not cp_raw.isdigit():
            raise SystemExit(f"Ligne {row_number} ({nom}) : code NCG ou code postal invalide.")
        code_postal = cp_raw.zfill(5)
        if zone not in ZONES:
            raise SystemExit(f"Ligne {row_number} ({nom}) : zone « {zone} » inattendue.")
        if nb_raw not in {"1", "2"}:
            raise SystemExit(
                f"Ligne {row_number} ({nom}) : nombre d'étudiants « {nb_raw} » inattendu (1 ou 2)."
            )
        nb = int(nb_raw)
        if code in seen:
            raise SystemExit(f"N°NCG en double dans le fichier : {code} ({nom}).")
        seen.add(code)

        if nb == 1:
            capacite_min, capacite_max = 1, 2
        else:
            capacite_min, capacite_max = 2, 4

        stores.append(
            {
                "nom": nom,
                "code_ncg": code,
                "zone": zone,
                "code_postal": code_postal,
                "ville": ville,
                "adresse": adresse,
                "nb_etudiants_ref": nb,
                "capacite_min": capacite_min,
                "capacite_max": capacite_max,
            }
        )

    workbook.close()
    if not stores:
        raise SystemExit("Aucun magasin lu dans le classeur.")
    return stores


def load_cache() -> dict:
    if not CACHE_PATH.exists():
        return {}
    return json.loads(CACHE_PATH.read_text(encoding="utf-8"))


def save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def address_queries(adresse: str, code_postal: str, ville: str) -> list[str]:
    text = " ".join(adresse.split())
    parts = [part.strip() for part in text.split(",") if part.strip()]
    queries = [text]
    if len(parts) >= 2:
        queries.append(f"{parts[0]}, {parts[-1]}")
    queries.append(f"{code_postal} {ville}")
    unique = []
    for query in queries:
        if query not in unique:
            unique.append(query)
    return unique


def geocode_address(session: requests.Session, adresse: str, code_postal: str, ville: str) -> dict | None:
    queries = address_queries(adresse, code_postal, ville)
    for index, query in enumerate(queries):
        response = session.get(BAN_URL, params={"q": query, "limit": 5}, timeout=20)
        response.raise_for_status()
        features = response.json().get("features") or []
        same = [
            feature
            for feature in features
            if str(feature["properties"].get("postcode") or "") == code_postal
        ]
        if not same:
            continue
        feature = max(same, key=lambda item: float(item["properties"].get("score") or 0))
        lon, lat = feature["geometry"]["coordinates"]
        props = feature["properties"]
        return {
            "latitude": lat,
            "longitude": lon,
            "score": props.get("score"),
            "ban": props.get("label") or "",
            "postcode": code_postal,
            "approximate": index == len(queries) - 1,
        }
    return None


def supabase_headers(key: str) -> dict:
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def existing_codes(url: str, key: str) -> set[str]:
    response = requests.get(
        f"{url.rstrip('/')}/rest/v1/magasins",
        params={"select": "code_ncg"},
        headers=supabase_headers(key),
        timeout=60,
    )
    response.raise_for_status()
    return {str(row["code_ncg"]) for row in response.json()}


def update_store(url: str, key: str, code: str, row: dict) -> None:
    response = requests.patch(
        f"{url.rstrip('/')}/rest/v1/magasins",
        params={"code_ncg": f"eq.{code}"},
        headers={**supabase_headers(key), "Prefer": "return=minimal"},
        json=row,
        timeout=60,
    )
    if not response.ok:
        raise SystemExit(f"Mise à jour Supabase refusée ({response.status_code}) : {response.text}")


def insert_stores(url: str, key: str, rows: list[dict]) -> None:
    response = requests.post(
        f"{url.rstrip('/')}/rest/v1/magasins",
        headers={**supabase_headers(key), "Prefer": "return=minimal"},
        json=rows,
        timeout=60,
    )
    if not response.ok:
        raise SystemExit(f"Insertion Supabase refusée ({response.status_code}) : {response.text}")


def print_summary(stores: list[dict]) -> None:
    print(f"{len(stores)} magasins lus.")
    for zone in sorted(ZONES):
        group = [store for store in stores if store["zone"] == zone]
        floor = sum(store["capacite_min"] for store in group)
        ceiling = sum(store["capacite_max"] for store in group)
        print(f"  {zone} : {len(group)} magasins, capacités {floor}–{ceiling}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Importe les magasins Darty dans Supabase.")
    parser.add_argument("xlsx", type=Path, help="Classeur du listing magasins")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Géocode et affiche le résultat sans écrire dans Supabase",
    )
    args = parser.parse_args()

    if not args.xlsx.exists():
        raise SystemExit(f"Fichier introuvable : {args.xlsx}")

    load_dotenv(ROOT / ".env")
    stores = load_stores(args.xlsx)
    print_summary(stores)

    cache = load_cache()
    session = requests.Session()
    failures = []
    for store in stores:
        cached = cache.get(store["code_ncg"])
        if cached and cached.get("source") == store["adresse"]:
            store["latitude"] = cached["latitude"]
            store["longitude"] = cached["longitude"]
            continue
        found = geocode_address(session, store["adresse"], store["code_postal"], store["ville"])
        time.sleep(0.05)
        if not found:
            failures.append(store["nom"])
            continue
        if found["approximate"] or (found["score"] is not None and found["score"] < 0.5):
            print(f"  Repère approximatif ({found['score']}) pour {store['nom']} → {found['ban']}")
        payload = {
            "source": store["adresse"],
            "latitude": found["latitude"],
            "longitude": found["longitude"],
        }
        cache[store["code_ncg"]] = payload
        save_cache(cache)
        store["latitude"] = found["latitude"]
        store["longitude"] = found["longitude"]

    if failures:
        raise SystemExit("Géocodage impossible pour : " + ", ".join(failures))

    missing_coords = [store["nom"] for store in stores if "latitude" not in store]
    if missing_coords:
        raise SystemExit("Coordonnées manquantes pour : " + ", ".join(missing_coords))

    for store in stores:
        print(f"  {store['zone']}  {store['nom']}  {store['adresse']}")

    if args.dry_run:
        print("Essai à blanc : aucune écriture dans Supabase.")
        return

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise SystemExit("Renseignez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY dans algo/.env.")

    already = existing_codes(url, key)
    fresh = []
    updated = 0
    for store in stores:
        row = {
            "nom": store["nom"],
            "code_ncg": store["code_ncg"],
            "zone": store["zone"],
            "code_postal": store["code_postal"],
            "ville": store["ville"],
            "adresse": store["adresse"],
            "latitude": store["latitude"],
            "longitude": store["longitude"],
            "capacite_min": store["capacite_min"],
            "capacite_max": store["capacite_max"],
            "nb_etudiants_ref": store["nb_etudiants_ref"],
        }
        if store["code_ncg"] in already:
            fields = dict(row)
            fields.pop("code_ncg")
            update_store(url, key, store["code_ncg"], fields)
            updated += 1
            continue
        fresh.append(row)

    if fresh:
        insert_stores(url, key, fresh)
    print(f"{len(fresh)} magasins insérés, {updated} mis à jour.")


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as exc:
        raise SystemExit(f"Erreur réseau : {exc}") from exc
