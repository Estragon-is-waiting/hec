import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const IDF = new Set(["75", "77", "78", "91", "92", "93", "94", "95"]);
const EMAIL_RE = /^[^\s@]+@hec\.edu$/i;
const ALGORITHMS = [
  { id: 5, code: "adresses_pire", family: "Adresses", name: "Pire trajet" },
];
const PHASES = {
  saisie: "Saisie des vœux",
  calcul: "Calculs en cours",
  vote: "Fin de la saisie des vœux",
  clos: "Affectation publiée",
};

const state = {
  phase: null,
  magasins: [],
  nom: "",
  prenom: "",
  email: "",
  adresse: null,
  query: "",
  suggestions: [],
  suggestIndex: 0,
  suggestMessage: "",
  ranking: [],
  submitting: false,
  choice: null,
  voting: false,
  tab: "voeux",
};

const app = document.querySelector("#app");
const phaseLabel = document.querySelector("#phase-label");

let supabase = null;
let addressTimer = null;
let addressAbort = null;
let dragFrom = null;
let pickerMap = null;
let departMap = null;
let pickerLayer = null;
let pickerFitted = false;
let resultMap = null;

const TILES = {
  url: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
  options: {
    attribution: '&copy; OpenStreetMap France',
    maxZoom: 20,
  },
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatVille(ville) {
  return String(ville || "")
    .toLocaleLowerCase("fr")
    .replace(/(^|[\s'-])(\p{L})/gu, (_match, sep, letter) => sep + letter.toLocaleUpperCase("fr"));
}

function storeTitle(store) {
  return `Darty ${String(store.nom || "").trim()}`;
}

function storeLine(store) {
  const address = String(store.adresse || "").trim();
  if (address) return address;
  return `${formatVille(store.ville)} · ${store.code_postal}`;
}

function hasCoords(store) {
  return Number.isFinite(Number(store?.latitude)) && Number.isFinite(Number(store?.longitude));
}

function destroyMaps() {
  if (pickerMap) {
    pickerMap.remove();
    pickerMap = null;
    pickerLayer = null;
    pickerFitted = false;
  }
  if (resultMap) {
    resultMap.remove();
    resultMap = null;
  }
  if (departMap) {
    departMap.remove();
    departMap = null;
  }
}

function storeIcon(rank, dimmed) {
  const classes = ["map-pin", rank ? "map-pin-on" : "", dimmed ? "map-pin-dim" : ""].filter(Boolean).join(" ");
  return L.divIcon({
    className: "pin-wrap",
    html: `<span class="${classes}">${rank || ""}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}


function baseTiles() {
  return L.tileLayer(TILES.url, TILES.options);
}

function formatClock(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "—";
  return `${Number(match[1])} h ${match[2]}`;
}

function publishedMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatMin(value) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
  return `${text} min`;
}

function histogramUpper(values) {
  const peak = values.length ? Math.max(...values) : 0;
  return Math.max(5, (Math.floor(peak / 5) + 1) * 5);
}

function histogramBins(values, upper) {
  const bins = [];
  for (let start = 0; start < upper; start += 5) {
    const end = start + 5;
    bins.push({
      start,
      end,
      count: values.filter((value) => value >= start && value < end).length,
    });
  }
  return bins;
}

function histogramMarkup(values, upper, yMax) {
  const bins = histogramBins(values, upper);
  const bars = bins
    .map((bin) => {
      const height = yMax ? Math.round((bin.count / yMax) * 100) : 0;
      return `<div class="hist-col"><div class="hist-bar" style="height:${height}%"></div><span class="hist-n">${bin.count}</span><span class="hist-label">${bin.start}–${bin.end}</span></div>`;
    })
    .join("");
  return `<div class="hist" role="img" aria-label="Nombre d’étudiants par tranche de 5 minutes">${bars}</div>`;
}

function formatPct(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)} %`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values) {
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function showFatal(message) {
  phaseLabel.textContent = "";
  app.innerHTML = `<p class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">${esc(message)}</p>`;
}

function fieldClass() {
  return "mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-base outline-none ring-accent focus:ring-2";
}

function gaps() {
  const missing = [];
  if (!state.nom.trim() || !state.prenom.trim()) missing.push("le nom et le prénom");
  if (!EMAIL_RE.test(state.email.trim())) missing.push("un email @hec.edu");
  if (!state.adresse) missing.push("une adresse sélectionnée dans la liste");
  if (state.ranking.length !== 10) missing.push(`exactement 10 magasins (${state.ranking.length}/10)`);
  return missing;
}

function visibleStores() {
  const query = state.query.trim().toLocaleLowerCase("fr");
  if (!query) return state.magasins;
  return state.magasins.filter((store) => {
    const haystack = `${store.nom} ${store.ville} ${store.code_postal} ${store.adresse || ""}`.toLocaleLowerCase("fr");
    return haystack.includes(query);
  });
}

function paintHint() {
  const hint = document.querySelector("#hint");
  const button = document.querySelector("#submit");
  if (!hint || !button) return;
  const missing = gaps();
  button.disabled = missing.length > 0 || state.submitting;
  button.textContent = state.submitting ? "Envoi…" : "Valider mes vœux";
  hint.textContent = missing.length
    ? `Il reste à renseigner : ${missing.join(", ")}.`
    : "Tout est prêt. Vous ne pourrez envoyer vos vœux qu’une seule fois.";
}

function paintSuggestions() {
  const list = document.querySelector("#suggestions");
  const input = document.querySelector("#adresse");
  if (!list || !input) return;
  const open = state.suggestions.length > 0 || state.suggestMessage;
  input.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) {
    list.innerHTML = "";
    list.classList.add("hidden");
    return;
  }
  list.classList.remove("hidden");
  if (state.suggestMessage) {
    list.innerHTML = `<li class="px-3 py-2 text-sm text-stone-600">${esc(state.suggestMessage)}</li>`;
    return;
  }
  list.innerHTML = state.suggestions
    .map(
      (item, index) => `
        <li>
          <button type="button" data-suggest="${index}" class="block w-full px-3 py-2 text-left text-sm ${index === state.suggestIndex ? "suggest-active" : ""}">
            ${esc(item.label)}
          </button>
        </li>`,
    )
    .join("");
}

function paintStores() {
  const list = document.querySelector("#store-list");
  const count = document.querySelector("#store-count");
  if (!list) return;
  const stores = visibleStores();
  const selected = new Map(state.ranking.map((store, index) => [store.id, index + 1]));
  const full = state.ranking.length >= 10;
  if (count) count.textContent = `${stores.length} magasin${stores.length > 1 ? "s" : ""}`;
  if (!state.magasins.length) {
    list.innerHTML = `<p class="px-3 py-6 text-sm text-stone-500">La liste des magasins n’est pas encore disponible.</p>`;
    syncPickerMap();
    return;
  }
  if (!stores.length) {
    list.innerHTML = `<p class="px-3 py-6 text-sm text-stone-500">Aucun magasin ne correspond à cette recherche.</p>`;
    syncPickerMap();
    return;
  }
  list.innerHTML = stores
    .map((store) => {
      const rank = selected.get(store.id);
      const action = rank
        ? `<span class="shrink-0 text-sm font-semibold text-accent">Vœu n°${rank}</span>`
        : `<button type="button" data-add="${store.id}" class="shrink-0 rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40" ${full ? "disabled" : ""}>Ajouter</button>`;
      return `
        <li data-focus="${store.id}" class="flex cursor-pointer items-center justify-between gap-3 border-b border-line px-3 py-3 last:border-b-0 hover:bg-[#f6e4d8]">
          <div class="min-w-0">
            <p class="font-medium">${esc(storeTitle(store))}</p>
            <p class="text-sm leading-snug text-stone-500">${esc(storeLine(store))}</p>
          </div>
          ${action}
        </li>`;
    })
    .join("");
  syncPickerMap();
}

function popupHtml(store, rank, full) {
  const action = rank
    ? `<p class="mt-1 font-semibold">Vœu n°${rank}</p>`
    : `<button type="button" data-add="${store.id}" ${full ? "disabled" : ""}>Ajouter à mes vœux</button>`;
  return `<div class="map-popup"><strong>${esc(storeTitle(store))}</strong><p>${esc(storeLine(store))}</p>${action}</div>`;
}

function syncPickerMap() {
  if (!pickerMap || !pickerLayer || typeof L === "undefined") return;
  pickerLayer.clearLayers();
  const filtering = state.query.trim().length > 0;
  const visible = new Set(visibleStores().map((store) => store.id));
  const ranks = new Map(state.ranking.map((store, index) => [store.id, index + 1]));
  const full = state.ranking.length >= 10;
  const points = [];

  for (const store of state.magasins) {
    if (!hasCoords(store)) continue;
    const rank = ranks.get(store.id) || 0;
    const marker = L.marker([Number(store.latitude), Number(store.longitude)], {
      icon: storeIcon(rank, filtering && !visible.has(store.id)),
      zIndexOffset: rank ? 500 : 0,
    });
    marker.bindPopup(popupHtml(store, rank, full && !rank));
    marker.addTo(pickerLayer);
    points.push(marker.getLatLng());
  }

  if (state.adresse) {
    const home = L.circleMarker([state.adresse.lat, state.adresse.lon], {
      radius: 8,
      color: "#1e3a8a",
      weight: 2,
      fillColor: "#1d4ed8",
      fillOpacity: 1,
    });
    home.bindPopup("Votre adresse");
    home.addTo(pickerLayer);
    points.push(home.getLatLng());
  }

  if (!pickerFitted && points.length) {
    pickerMap.fitBounds(L.latLngBounds(points).pad(0.12));
    pickerFitted = true;
  }
}

function focusStore(id) {
  if (!pickerMap || !pickerLayer) return;
  const store = state.magasins.find((item) => item.id === id);
  if (!store || !hasCoords(store)) return;
  const lat = Number(store.latitude);
  const lon = Number(store.longitude);
  pickerMap.flyTo([lat, lon], Math.max(pickerMap.getZoom(), 14), { duration: 0.5 });
  pickerLayer.eachLayer((layer) => {
    if (!layer.getLatLng || !layer.openPopup) return;
    const point = layer.getLatLng();
    if (Math.abs(point.lat - lat) < 1e-5 && Math.abs(point.lng - lon) < 1e-5 && !layer.options?.fillColor) {
      layer.openPopup();
    }
  });
}

function initPickerMap() {
  const element = document.querySelector("#store-map");
  if (!element || typeof L === "undefined") return;
  pickerFitted = false;
  pickerMap = L.map(element, { scrollWheelZoom: true }).setView([48.86, 2.35], 9);
  baseTiles().addTo(pickerMap);
  pickerLayer = L.layerGroup().addTo(pickerMap);
  pickerMap.on("popupopen", (event) => {
    const button = event.popup.getElement()?.querySelector("[data-add]");
    if (!button) return;
    button.addEventListener("click", () => addStore(Number(button.dataset.add)));
  });
  window.setTimeout(() => pickerMap.invalidateSize(), 0);
}

function showResultMap(storeA, storeB) {
  const element = document.querySelector("#result-map");
  if (!element || typeof L === "undefined") return;
  if (resultMap) resultMap.remove();
  resultMap = L.map(element, { scrollWheelZoom: true }).setView([48.86, 2.35], 9);
  baseTiles().addTo(resultMap);
  const points = [];
  const same = storeA && storeB && storeA.id === storeB.id;
  const places = same
    ? [{ store: storeA, label: "Options 1 et 2", rank: "1·2" }]
    : [
        { store: storeA, label: "Option 1 — trajets", rank: "1" },
        { store: storeB, label: "Option 2 — vœux", rank: "2" },
      ];
  for (const place of places) {
    if (!hasCoords(place.store)) continue;
    const marker = L.marker([Number(place.store.latitude), Number(place.store.longitude)], {
      icon: storeIcon(place.rank, false),
    });
    marker.bindPopup(
      `<div class="map-popup"><strong>${esc(place.label)}</strong><p>${esc(storeTitle(place.store))}</p><p>${esc(storeLine(place.store))}</p></div>`,
    );
    marker.addTo(resultMap);
    points.push(marker.getLatLng());
  }
  if (points.length === 1) resultMap.setView(points[0], 13);
  else if (points.length > 1) resultMap.fitBounds(L.latLngBounds(points).pad(0.4));
  window.setTimeout(() => resultMap.invalidateSize(), 50);
}

function paintRanking() {
  const list = document.querySelector("#ranking");
  if (!list) return;
  if (!state.ranking.length) {
    list.innerHTML = `<p class="px-3 py-6 text-sm text-stone-500">Ajoutez dix magasins. Le premier de la liste sera votre vœu n°1.</p>`;
    return;
  }
  list.innerHTML = state.ranking
    .map(
      (store, index) => `
        <li data-index="${index}" draggable="true" class="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
          <span class="w-6 font-serif text-lg text-accent">${index + 1}</span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium">${esc(storeTitle(store))}</p>
            <p class="truncate text-sm text-stone-500">${esc(storeLine(store))}</p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button type="button" data-move="-1" class="rounded border border-line px-2 py-1 text-sm disabled:opacity-30" ${index === 0 ? "disabled" : ""} aria-label="Monter">↑</button>
            <button type="button" data-move="1" class="rounded border border-line px-2 py-1 text-sm disabled:opacity-30" ${index === state.ranking.length - 1 ? "disabled" : ""} aria-label="Descendre">↓</button>
            <button type="button" data-remove class="rounded border border-line px-2 py-1 text-sm hover:border-red-700 hover:text-red-800" aria-label="Retirer">Retirer</button>
          </div>
        </li>`,
    )
    .join("");

  list.querySelectorAll("[data-index]").forEach((item) => {
    item.addEventListener("dragstart", (event) => {
      dragFrom = Number(item.dataset.index);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.dataset.index);
      item.classList.add("opacity-50");
    });
    item.addEventListener("dragend", () => item.classList.remove("opacity-50"));
    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      item.classList.add("rank-over");
    });
    item.addEventListener("dragleave", () => item.classList.remove("rank-over"));
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      item.classList.remove("rank-over");
      const from = dragFrom;
      const to = Number(item.dataset.index);
      dragFrom = null;
      reorder(from, to);
    });
  });
}

function reorder(from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
  if (from < 0 || to < 0 || from >= state.ranking.length || to >= state.ranking.length) return;
  const [moved] = state.ranking.splice(from, 1);
  state.ranking.splice(to, 0, moved);
  paintRanking();
  paintStores();
}

function addStore(id) {
  if (state.ranking.length >= 10) return;
  if (state.ranking.some((store) => store.id === id)) return;
  const store = state.magasins.find((item) => item.id === id);
  if (!store) return;
  state.ranking.push(store);
  paintRanking();
  paintStores();
  paintHint();
}

function selectSuggestion(index) {
  const item = state.suggestions[index];
  if (!item) return;
  state.adresse = { label: item.label, lat: item.lat, lon: item.lon };
  const input = document.querySelector("#adresse");
  if (input) input.value = item.label;
  state.suggestions = [];
  state.suggestMessage = "";
  paintSuggestions();
  paintHint();
  syncPickerMap();
}

async function fetchAddresses(query) {
  if (addressAbort) addressAbort.abort();
  addressAbort = new AbortController();
  try {
    const url = new URL("https://api-adresse.data.gouv.fr/search/");
    url.searchParams.set("q", query);
    url.searchParams.set("type", "housenumber");
    url.searchParams.set("limit", "10");
    const response = await fetch(url, { signal: addressAbort.signal });
    if (!response.ok) throw new Error("ban");
    const data = await response.json();
    const items = [];
    for (const feature of data.features || []) {
      const postcode = String(feature.properties?.postcode || "");
      if (!IDF.has(postcode.slice(0, 2))) continue;
      const [lon, lat] = feature.geometry.coordinates;
      items.push({ label: feature.properties.label, lat, lon, postcode });
      if (items.length === 5) break;
    }
    state.suggestions = items;
    state.suggestIndex = 0;
    state.suggestMessage = items.length ? "" : "Aucune adresse en Île-de-France.";
    paintSuggestions();
  } catch (error) {
    if (error.name === "AbortError") return;
    state.suggestions = [];
    state.suggestMessage = "Le service d’adresse ne répond pas.";
    paintSuggestions();
  }
}

function onAddressInput(value) {
  if (!state.adresse || state.adresse.label !== value) {
    state.adresse = null;
    paintHint();
  }
  window.clearTimeout(addressTimer);
  if (value.trim().length < 3) {
    if (addressAbort) addressAbort.abort();
    state.suggestions = [];
    state.suggestMessage = "";
    paintSuggestions();
    return;
  }
  addressTimer = window.setTimeout(() => fetchAddresses(value.trim()), 300);
}

async function currentPhase() {
  const { data, error } = await supabase.from("app_config").select("phase").eq("id", 1).single();
  if (error) throw error;
  return data.phase;
}

async function submitWishes() {
  if (gaps().length || state.submitting) return;
  state.submitting = true;
  paintHint();
  const errorBox = document.querySelector("#form-error");
  if (errorBox) errorBox.textContent = "";
  try {
    const phase = await currentPhase();
    if (phase !== "saisie") {
      if (errorBox) errorBox.textContent = "La collecte des vœux est close.";
      return;
    }
    const { error } = await supabase.from("etudiants_voeux").insert({
      nom: state.nom.trim(),
      prenom: state.prenom.trim(),
      email: state.email.trim().toLowerCase(),
      adresse_exacte: state.adresse.label,
      latitude: state.adresse.lat,
      longitude: state.adresse.lon,
      voeux: state.ranking.map((store) => store.id),
    });
    if (error) {
      const duplicate = error.code === "23505" || /duplicate|unique/i.test(error.message || "");
      if (errorBox) {
        errorBox.textContent = duplicate
          ? "Cet email a déjà soumis des vœux."
          : "L’envoi n’a pas abouti. Réessayez dans un instant.";
      }
      return;
    }
    state.tab = "voiture";
    renderTabs();
  } catch {
    if (errorBox) errorBox.textContent = "L’envoi n’a pas abouti. Réessayez dans un instant.";
  } finally {
    state.submitting = false;
    paintHint();
  }
}

function renderCar(prefill, thanks) {
  const consultation = state.phase === "vote" || state.phase === "clos";
  const intro = thanks
    ? `<h2 class="font-serif text-3xl">Vœux enregistrés</h2>
       <p class="mt-3 max-w-xl text-stone-700">Votre classement est enregistré. Un même email ne peut envoyer qu’une seule fois. Indiquez si vous avez une voiture : le défaut est non, et vous pouvez changer d’avis tant que la collecte est ouverte.</p>`
    : consultation
      ? `<h2 class="font-serif text-3xl">Voiture</h2>
         <p class="mt-3 max-w-xl text-stone-700">Indiquez l’adresse @hec.edu déjà enregistrée, puis dites si vous avez une voiture. Le défaut est non. Vous pouvez modifier ce choix tant que l’affectation n’est pas publiée.</p>`
      : `<h2 class="font-serif text-3xl">Voiture</h2>
         <p class="mt-3 max-w-xl text-stone-700">Après avoir envoyé vos vœux, indiquez si vous avez une voiture. Le défaut est non. Vous pouvez modifier ce choix tant que la collecte est ouverte.</p>`;
  const panel = document.querySelector("#panel") || app;
  panel.innerHTML = `
    <section class="max-w-xl rounded-xl border border-line bg-card p-5">
      ${intro}
      <form id="car-form" class="mt-6 space-y-4">
        <label class="block text-sm font-medium">Email
          <input id="car-email" type="email" required autocomplete="email" pattern="[^\\s@]+@hec\\.edu" title="Adresse @hec.edu" value="${esc(prefill || "")}" class="${fieldClass()}" placeholder="prenom.nom@hec.edu" />
        </label>
        <fieldset>
          <legend class="text-sm font-medium">Avez-vous une voiture ?</legend>
          <label class="mt-2 flex items-center gap-2 text-sm"><input type="radio" name="voiture" value="non" checked /> Non</label>
          <label class="mt-1 flex items-center gap-2 text-sm"><input type="radio" name="voiture" value="oui" /> Oui</label>
        </fieldset>
        <div class="flex flex-wrap gap-3">
          <button type="submit" class="rounded-md bg-accent px-4 py-2 font-semibold text-white">Enregistrer</button>
        </div>
        <p id="car-status" class="text-sm text-stone-700" role="status"></p>
        <p id="car-error" class="text-sm text-red-800" role="alert"></p>
      </form>
    </section>`;

  const emailInput = document.querySelector("#car-email");
  const status = document.querySelector("#car-status");
  const errorBox = document.querySelector("#car-error");

  async function loadCar() {
    errorBox.textContent = "";
    if (!supabase) {
      status.textContent = "Aperçu local : le choix de voiture n’est pas enregistré.";
      return;
    }
    const email = emailInput.value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return;
    const { data, error } = await supabase.from("mobilite").select("a_voiture").eq("email", email).maybeSingle();
    if (error) {
      errorBox.textContent = "Impossible de lire le choix déjà enregistré.";
      return;
    }
    const hasCar = Boolean(data?.a_voiture);
    document.querySelector(`input[name="voiture"][value="${hasCar ? "oui" : "non"}"]`).checked = true;
    status.textContent = data ? (hasCar ? "Choix actuel : oui." : "Choix actuel : non.") : "Pas encore de réponse : non.";
  }

  emailInput.addEventListener("change", loadCar);
  document.querySelector("#car-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.textContent = "";
    status.textContent = "";
    if (!supabase) {
      errorBox.textContent = "Aperçu local : le choix de voiture n’est pas enregistré.";
      return;
    }
    const email = emailInput.value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      errorBox.textContent = "Indiquez une adresse @hec.edu.";
      return;
    }
    try {
      const phase = await currentPhase();
      if (phase !== "saisie" && phase !== "vote") {
        errorBox.textContent = "L’affectation est publiée : ce choix ne peut plus être modifié.";
        return;
      }
    } catch {
      errorBox.textContent = "Impossible de vérifier que la collecte est encore ouverte.";
      return;
    }
    const hasCar = document.querySelector('input[name="voiture"]:checked').value === "oui";
    const { error } = await supabase.from("mobilite").upsert(
      { email, a_voiture: hasCar, updated_at: new Date().toISOString() },
      { onConflict: "email" },
    );
    if (error) {
      const missing = error.code === "23503" || /foreign key/i.test(error.message || "");
      errorBox.textContent = missing
        ? "Aucun vœu pour cet email. Envoyez d’abord votre classement."
        : "L’enregistrement n’a pas abouti. Réessayez.";
      return;
    }
    status.textContent = hasCar ? "Enregistré : vous avez une voiture." : "Enregistré : vous n’avez pas de voiture.";
  });
  loadCar();
}

function renderSaisie() {
  const panel = document.querySelector("#panel") || app;
  panel.innerHTML = `
    <form class="space-y-8 pb-28" autocomplete="on">
      <section class="rounded-xl border border-line bg-card p-5">
        <h2 class="font-serif text-2xl">Identité</h2>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <label class="block text-sm font-medium">Nom
            <input id="nom" name="family-name" autocomplete="family-name" required value="${esc(state.nom)}" class="${fieldClass()}" />
          </label>
          <label class="block text-sm font-medium">Prénom
            <input id="prenom" name="given-name" autocomplete="given-name" required value="${esc(state.prenom)}" class="${fieldClass()}" />
          </label>
          <label class="block text-sm font-medium sm:col-span-2">Email
            <input id="email" name="email" type="email" autocomplete="email" required pattern="[^\\s@]+@hec\\.edu" title="Adresse @hec.edu" value="${esc(state.email)}" class="${fieldClass()}" placeholder="prenom.nom@hec.edu" />
          </label>
        </div>
      </section>

      <section class="rounded-xl border border-line bg-card p-5">
        <h2 class="font-serif text-2xl">Adresse en Île-de-France</h2>
        <p class="mt-1 text-sm text-stone-600">Choisissez une adresse proposée. Une adresse saisie à la main n’est pas acceptée.</p>
        <div class="relative mt-4">
          <label class="block text-sm font-medium" for="adresse">Adresse postale</label>
          <input id="adresse" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="suggestions" autocomplete="off" value="${esc(state.adresse ? state.adresse.label : "")}" class="${fieldClass()}" />
          <ul id="suggestions" role="listbox" class="absolute z-20 mt-1 hidden max-h-64 w-full overflow-auto rounded-md border border-line bg-white shadow-lg"></ul>
        </div>
      </section>

      <section>
        <h2 class="font-serif text-2xl">Dix magasins, dans l’ordre</h2>
        <p class="mt-1 text-sm text-stone-600">La carte situe chaque magasin. Cliquez un point pour l’ajouter, puis classez vos dix vœux. Le rang 1 est celui que vous préférez.</p>
        <div class="relative z-0 mt-4 overflow-hidden rounded-xl border border-line">
          <div id="store-map" class="h-[28rem] w-full"></div>
          <p class="flex flex-wrap gap-4 border-t border-line bg-card px-3 py-2 text-xs text-stone-600">
            <span class="inline-flex items-center gap-1"><span class="inline-block h-3 w-3 rounded-full border-2 border-ink bg-card"></span> Magasin</span>
            <span class="inline-flex items-center gap-1"><span class="inline-block h-3 w-3 rounded-full bg-accent"></span> Vœu classé</span>
            <span class="inline-flex items-center gap-1"><span class="inline-block h-3 w-3 rounded-full bg-blue-700"></span> Votre adresse</span>
          </p>
        </div>
        <div class="mt-4 grid items-start gap-4 lg:grid-cols-2">
          <div class="rounded-xl border border-line bg-card">
            <div class="border-b border-line p-3">
              <label class="block text-sm font-medium" for="search">Rechercher un magasin</label>
              <input id="search" class="${fieldClass()}" placeholder="Nom, ville, code postal ou adresse" autocomplete="off" />
              <p id="store-count" class="mt-2 text-xs text-stone-500"></p>
            </div>
            <ul id="store-list" class="max-h-[28rem] overflow-auto"></ul>
          </div>
          <div class="rounded-xl border border-line bg-card lg:sticky lg:top-4">
            <div class="border-b border-line px-3 py-3">
              <h3 class="font-medium">Votre classement</h3>
            </div>
            <ul id="ranking"></ul>
          </div>
        </div>
      </section>
      <p id="form-error" class="text-sm text-red-800" role="alert"></p>
    </form>
    <div class="fixed inset-x-0 bottom-0 border-t border-line bg-card/95 backdrop-blur">
      <div class="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p id="hint" class="text-sm text-stone-600"></p>
        <button id="submit" type="button" class="rounded-md bg-accent px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">Valider mes vœux</button>
      </div>
    </div>`;

  document.querySelector("#nom").addEventListener("input", (event) => {
    state.nom = event.target.value;
    paintHint();
  });
  document.querySelector("#prenom").addEventListener("input", (event) => {
    state.prenom = event.target.value;
    paintHint();
  });
  document.querySelector("#email").addEventListener("input", (event) => {
    state.email = event.target.value;
    paintHint();
  });

  const adresse = document.querySelector("#adresse");
  adresse.addEventListener("input", (event) => onAddressInput(event.target.value));
  adresse.addEventListener("keydown", (event) => {
    if (!state.suggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.suggestIndex = Math.min(state.suggestions.length - 1, state.suggestIndex + 1);
      paintSuggestions();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      state.suggestIndex = Math.max(0, state.suggestIndex - 1);
      paintSuggestions();
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectSuggestion(state.suggestIndex);
    } else if (event.key === "Escape") {
      state.suggestions = [];
      state.suggestMessage = "";
      paintSuggestions();
    }
  });
  document.querySelector("#suggestions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-suggest]");
    if (!button) return;
    selectSuggestion(Number(button.dataset.suggest));
  });

  document.querySelector("#search").addEventListener("input", (event) => {
    state.query = event.target.value;
    paintStores();
  });
  document.querySelector("#store-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-add]");
    if (button) {
      addStore(Number(button.dataset.add));
      return;
    }
    const row = event.target.closest("[data-focus]");
    if (row) focusStore(Number(row.dataset.focus));
  });
  document.querySelector("#ranking").addEventListener("click", (event) => {
    const item = event.target.closest("[data-index]");
    if (!item) return;
    const index = Number(item.dataset.index);
    if (event.target.closest("[data-remove]")) {
      state.ranking.splice(index, 1);
      paintRanking();
      paintStores();
      paintHint();
      return;
    }
    const move = event.target.closest("[data-move]");
    if (!move || move.disabled) return;
    reorder(index, index + Number(move.dataset.move));
  });
  document.querySelector("#submit").addEventListener("click", submitWishes);
  document.querySelector("form").addEventListener("submit", (event) => event.preventDefault());

  initPickerMap();
  paintStores();
  paintRanking();
  paintHint();
}

function statBlock(title, rows, timeKey, rankKey) {
  const times = rows.map((row) => Number(row[timeKey])).filter((value) => Number.isFinite(value));
  const top = rows.length ? rows.filter((row) => Number(row[rankKey]) <= 3).length / rows.length : NaN;
  return `
    <article class="rounded-xl border border-line bg-white p-4">
      <h3 class="font-medium">${esc(title)}</h3>
      <dl class="mt-3 space-y-1 text-sm">
        <div class="flex justify-between gap-4"><dt>Temps moyen</dt><dd>${esc(formatMin(times.length ? average(times) : NaN))}</dd></div>
        <div class="flex justify-between gap-4"><dt>Écart-type</dt><dd>${esc(formatMin(times.length ? deviation(times) : NaN))}</dd></div>
        <div class="flex justify-between gap-4"><dt>Maximum</dt><dd>${esc(formatMin(times.length ? Math.max(...times) : NaN))}</dd></div>
        <div class="flex justify-between gap-4"><dt>Top 3 des vœux</dt><dd>${esc(formatPct(top))}</dd></div>
      </dl>
    </article>`;
}

function groupCharts(results, algos = ALGORITHMS) {
  const disclaimer = `<p class="max-w-3xl text-sm text-stone-700">Ces graphiques sont calculés avec l’option voiture désactivée pour tout le monde, en attendant un calcul qui tiendra compte des réponses.</p>`;
  if (!results.length) {
    return `${disclaimer}<p class="mt-4 text-sm text-stone-600">Les répartitions ne sont pas encore calculées.</p>`;
  }
  const grouped = algos.map((algo) =>
    results.filter((row) => row.algo === algo.code).map((row) => Number(row.temps_min)),
  );
  const upper = histogramUpper(grouped.flat());
  const yMax = Math.max(
    1,
    ...grouped.map((times) => Math.max(0, ...histogramBins(times, upper).map((bin) => bin.count))),
  );
  const cards = algos.map((algo, index) => `
    <article class="rounded-xl border border-line bg-card p-5">
      <h3 class="font-serif text-2xl">${esc(algo.name)}</h3>
      ${histogramMarkup(grouped[index], upper, yMax)}
    </article>`).join("");
  return `${disclaimer}<div class="mt-6 grid gap-4 lg:grid-cols-2">${cards}</div>`;
}

function renderTabs() {
  destroyMaps();
  app.innerHTML = `
    <div class="tabs" role="tablist">
      <button type="button" class="tab ${state.tab === "voeux" ? "tab-on" : ""}" data-tab="voeux" role="tab">1. Vœux</button>
      <button type="button" class="tab ${state.tab === "voiture" ? "tab-on" : ""}" data-tab="voiture" role="tab">2. Voiture</button>
      <button type="button" class="tab ${state.tab === "resultats" ? "tab-on" : ""}" data-tab="resultats" role="tab">3. Résultats</button>
    </div>
    <div id="panel"></div>`;
  app.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      renderTabs();
    });
  });
  if (state.tab === "voiture") {
    renderCar(state.email.trim().toLowerCase(), false);
    return;
  }
  if (state.tab === "resultats") {
    renderGroupResults();
    return;
  }
  renderSaisie();
}

async function renderGroupResults() {
  const panel = document.querySelector("#panel");
  if (!panel) return;
  panel.innerHTML = `<p class="text-sm text-stone-600">Chargement…</p>`;
  if (!supabase) {
    panel.innerHTML = groupCharts([]);
    return;
  }
  const { data, error } = await supabase.from("resultats_affectation").select("algo,temps_min");
  if (state.tab !== "resultats") return;
  if (error) {
    panel.innerHTML = `<p class="text-sm text-red-800">Les graphiques n’ont pas pu être chargés.</p>`;
    return;
  }
  panel.innerHTML = groupCharts(data || []);
}

function renderCalcul() {
  app.innerHTML = `
    <section class="rounded-xl border border-line bg-card px-6 py-8">
      <h2 class="font-serif text-3xl">Collecte close</h2>
      <p class="mt-3 max-w-xl text-stone-700">Les vœux ne sont plus modifiables. L’affectation est en cours de calcul. Revenez sur cette page lorsqu’elle sera affichée.</p>
    </section>`;
}

async function loadPublishedRows() {
  const response = await fetch("repartition.json");
  if (!response.ok) throw new Error("repartition");
  return response.json();
}

function renderAssignment() {
  const panel = document.querySelector("#panel");
  panel.innerHTML = `
    <section class="max-w-xl rounded-xl border border-line bg-card p-5">
      <h2 class="font-serif text-2xl">Votre affectation</h2>
      <p class="mt-1 text-sm text-stone-600">Indiquez votre adresse @hec.edu pour voir votre magasin, la durée du trajet et l’heure d’arrivée.</p>
      <form id="assignment-form" class="mt-4 flex flex-col gap-3 sm:flex-row">
        <label class="sr-only" for="assignment-email">Email</label>
        <input id="assignment-email" type="email" required autocomplete="email" pattern="[^\\s@]+@hec\\.edu" title="Adresse @hec.edu" value="${esc(state.email)}" class="${fieldClass()}" placeholder="prenom.nom@hec.edu" />
        <button type="submit" class="rounded-md bg-accent px-4 py-2 font-semibold text-white">Voir mon affectation</button>
      </form>
      <p id="assignment-error" class="mt-3 text-sm text-red-800" role="alert"></p>
      <div id="assignment-box" class="mt-4"></div>
    </section>`;
  document.querySelector("#assignment-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.querySelector("#assignment-email").value.trim().toLowerCase();
    const errorBox = document.querySelector("#assignment-error");
    const box = document.querySelector("#assignment-box");
    errorBox.textContent = "";
    box.innerHTML = "";
    if (!EMAIL_RE.test(email)) {
      errorBox.textContent = "Indiquez une adresse @hec.edu.";
      return;
    }
    state.email = email;
    box.innerHTML = `<p class="text-sm text-stone-600">Chargement…</p>`;
    let rows = [];
    try {
      rows = await loadPublishedRows();
    } catch {
      if (state.tab !== "affectation") return;
      box.innerHTML = "";
      errorBox.textContent = "L’affectation n’a pas pu être chargée.";
      return;
    }
    if (state.tab !== "affectation") return;
    const row = rows.find((item) => String(item.email || "").toLowerCase() === email);
    const store = row ? state.magasins.find((item) => item.nom === row.magasin) : null;
    if (!row) {
      box.innerHTML = "";
      errorBox.textContent = "Aucune affectation pour cet email.";
      return;
    }
    const title = store ? storeTitle(store) : `Darty ${row.magasin}`;
    const line = store ? storeLine(store) : formatVille(row.ville);
    box.innerHTML = `
      <h3 class="font-serif text-2xl">${esc(title)}</h3>
      <p class="mt-1 text-sm text-stone-600">${esc(line)}</p>
      <p class="mt-4 text-sm">Trajet : <strong>${publishedMinutes(row.temps) === null ? "—" : formatMin(publishedMinutes(row.temps))}</strong></p>
      <p class="text-sm">Arrivée : <strong>${esc(formatClock(row.arrivee))}</strong></p>`;
  });
}

function renderConsultation() {
  destroyMaps();
  app.innerHTML = `
    <div class="tabs" role="tablist">
      <button type="button" class="tab ${state.tab === "affectation" ? "tab-on" : ""}" data-tab="affectation" role="tab">1. Affectation</button>
      <button type="button" class="tab ${state.tab === "voiture" ? "tab-on" : ""}" data-tab="voiture" role="tab">2. Voiture</button>
      <button type="button" class="tab ${state.tab === "resultats" ? "tab-on" : ""}" data-tab="resultats" role="tab">3. Résultats</button>
    </div>
    <div id="panel"></div>`;
  app.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      renderConsultation();
    });
  });
  if (state.tab === "resultats") {
    renderPublishedResults();
    return;
  }
  if (state.tab === "voiture") {
    renderCar(state.email.trim().toLowerCase(), false);
    return;
  }
  renderAssignment();
}


function publishedDistribution(rows) {
  const times = rows.map((row) => publishedMinutes(row.temps)).filter((value) => value !== null);
  const upper = histogramUpper(times);
  const yMax = Math.max(1, ...histogramBins(times, upper).map((bin) => bin.count));
  const body = rows
    .map((row) => `
      <tr class="border-b border-line last:border-b-0">
        <td class="px-3 py-2">${esc(row.nom)}</td>
        <td class="px-3 py-2">${esc(row.prenom)}</td>
        <td class="px-3 py-2">${esc(row.magasin)}</td>
        <td class="px-3 py-2">${esc(row.ville)}</td>
        <td class="px-3 py-2">${esc(row.zone)}</td>
        <td class="px-3 py-2 text-right font-semibold">${publishedMinutes(row.temps) === null ? "—" : formatMin(publishedMinutes(row.temps))}</td>
        <td class="px-3 py-2">${esc(formatClock(row.arrivee))}</td>
      </tr>`)
    .join("");
  return `
    <section class="mb-8">
      <h2 class="font-serif text-2xl">Une heure</h2>
      <p class="mt-1 max-w-3xl text-sm text-stone-600">${rows.length} personnes. Le graphique compte les durées renseignées, par tranches de 5 minutes.</p>
      <article class="mt-4 rounded-xl border border-line bg-card p-5">
        ${histogramMarkup(times, upper, yMax)}
      </article>
      <div class="mt-4 max-h-[28rem] overflow-auto rounded-xl border border-line bg-card">
        <table class="w-full text-left text-sm">
          <thead class="sticky top-0 bg-card text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th class="px-3 py-2 font-medium">Nom</th>
              <th class="px-3 py-2 font-medium">Prénom</th>
              <th class="px-3 py-2 font-medium">Magasin</th>
              <th class="px-3 py-2 font-medium">Ville</th>
              <th class="px-3 py-2 font-medium">Zone</th>
              <th class="px-3 py-2 text-right font-medium">Temps</th>
              <th class="px-3 py-2 font-medium">Arrivée</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>`;
}

async function renderPublishedResults() {
  const panel = document.querySelector("#panel");
  panel.innerHTML = `<p class="text-sm text-stone-600">Chargement…</p>`;
  let rows = [];
  try {
    rows = await loadPublishedRows();
  } catch {
    if (state.tab !== "resultats" || !panel.isConnected) return;
    panel.innerHTML = `<p class="text-sm text-red-800">La répartition n’a pas pu être chargée.</p>`;
    return;
  }
  if (state.tab !== "resultats" || !panel.isConnected) return;
  panel.innerHTML = publishedDistribution(rows);
}

async function render() {
  destroyMaps();
  phaseLabel.textContent = PHASES[state.phase] || "";
  if (state.phase === "saisie") {
    renderTabs();
    return;
  }
  if (state.phase === "calcul") {
    renderCalcul();
    return;
  }
  if (state.phase === "vote" || state.phase === "clos") {
    if (!["affectation", "voiture", "resultats"].includes(state.tab)) state.tab = "affectation";
    renderConsultation();
    return;
  }
  showFatal("Phase inconnue. Vérifiez la table app_config.");
}

async function init() {
  const config = window.HEC_CONFIG;
  if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY || config.SUPABASE_URL.includes("YOUR_PROJECT")) {
    try {
      const response = await fetch("algo/cache/preview.json");
      if (!response.ok) throw new Error("preview");
      state.phase = "saisie";
      state.magasins = await response.json();
      phaseLabel.textContent = "Aperçu local — les vœux ne sont pas enregistrés";
      renderTabs();
      return;
    } catch {
      showFatal("Configuration Supabase manquante. Copiez config.example.js vers config.js, ou relancez le build Vercel.");
      return;
    }
  }
  supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
  app.innerHTML = `<p class="text-sm text-stone-600">Chargement…</p>`;
  try {
    const [phaseResult, storesResult] = await Promise.all([
      supabase.from("app_config").select("phase").eq("id", 1).single(),
      supabase.from("magasins").select("id,nom,ville,code_postal,adresse,latitude,longitude").order("nom"),
    ]);
    if (phaseResult.error) throw phaseResult.error;
    if (storesResult.error) throw storesResult.error;
    state.phase = phaseResult.data.phase;
    state.magasins = (storesResult.data || [])
      .slice()
      .sort((a, b) => a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" }));
    await render();
  } catch {
    showFatal("Impossible de joindre la base. Vérifiez l’adresse du projet et que le schéma SQL a bien été exécuté.");
  }
}

init();
