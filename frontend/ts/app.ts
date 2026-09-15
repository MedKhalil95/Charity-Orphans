// Rahma — frontend application logic
// Talks to the FastAPI backend, renders the Leaflet map + card list,
// handles i18n (en/fr/ar with RTL), donations, and QR deep links.

declare const L: any; // Leaflet is loaded globally via <script> tag

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------
type TargetType = "orphan" | "association";

interface OrphanDTO {
  id: number;
  first_name: string;
  age: number;
  gender: string;
  latitude: number;
  longitude: number;
  city: string;
  story: string;
  needs: string;
  photo_url: string;
  monthly_goal: number;
  amount_raised: number;
  association_id: number | null;
  distance_km: number | null;
}

interface AssociationDTO {
  id: number;
  name: string;
  description: string;
  latitude: number;
  longitude: number;
  address: string;
  phone: string;
  logo_url: string;
  verified: boolean;
  distance_km: number | null;
}

// -----------------------------------------------------------------------
// Config / state
// -----------------------------------------------------------------------
const API_BASE = "/api";
type Lang = "en" | "fr" | "ar";
const RTL_LANGS: Lang[] = ["ar"];

let currentLang: Lang = (localStorage.getItem("rahma_lang") as Lang) || "en";
let translations: Record<string, string> = {};

let userPos: { lat: number; lng: number } | null = null;
let map: any;
let markers: any[] = [];
let userMarker: any = null;

let orphans: OrphanDTO[] = [];
let associations: AssociationDTO[] = [];
let activeTab: TargetType = "orphan";

const FALLBACK_CENTER = { lat: 36.8065, lng: 10.1815 }; // Tunis

// -----------------------------------------------------------------------
// i18n
// -----------------------------------------------------------------------
async function loadTranslations(lang: Lang): Promise<void> {
  const res = await fetch(`i18n/${lang}.json`);
  translations = await res.json();
}

function t(key: string): string {
  return translations[key] || key;
}

function applyTranslations(): void {
  document.documentElement.lang = currentLang;
  document.documentElement.dir = RTL_LANGS.includes(currentLang) ? "rtl" : "ltr";

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n")!;
    el.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder")!;
    (el as HTMLInputElement).placeholder = t(key);
  });

  document.querySelectorAll<HTMLButtonElement>(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === currentLang);
  });
}

async function setLang(lang: Lang): Promise<void> {
  currentLang = lang;
  localStorage.setItem("rahma_lang", lang);
  await loadTranslations(lang);
  applyTranslations();
  // Re-render dynamic content that embeds translated strings
  renderList();
  updateStatusMessage();
}

// -----------------------------------------------------------------------
// API calls
// -----------------------------------------------------------------------
async function fetchOrphans(): Promise<OrphanDTO[]> {
  const params = new URLSearchParams();
  if (userPos) {
    params.set("lat", String(userPos.lat));
    params.set("lng", String(userPos.lng));
    const radius = (document.getElementById("radiusRange") as HTMLInputElement).value;
    params.set("radius_km", radius);
  }
  const res = await fetch(`${API_BASE}/orphans?${params.toString()}`);
  return res.json();
}

async function fetchAssociations(): Promise<AssociationDTO[]> {
  const params = new URLSearchParams();
  if (userPos) {
    params.set("lat", String(userPos.lat));
    params.set("lng", String(userPos.lng));
    const radius = (document.getElementById("radiusRange") as HTMLInputElement).value;
    params.set("radius_km", radius);
  }
  const res = await fetch(`${API_BASE}/associations?${params.toString()}`);
  return res.json();
}

async function submitDonation(payload: any): Promise<any> {
  const res = await fetch(`${API_BASE}/donations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Donation failed");
  return res.json();
}

// -----------------------------------------------------------------------
// Geolocation
// -----------------------------------------------------------------------
function locateUser(): void {
  const statusEl = document.getElementById("statusMsg")!;
  statusEl.hidden = false;
  statusEl.textContent = t("locating");

  if (!navigator.geolocation) {
    userPos = null;
    updateStatusMessage(true);
    refreshData();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateStatusMessage();
      placeUserMarker();
      refreshData();
    },
    () => {
      userPos = null;
      updateStatusMessage(true);
      refreshData();
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function updateStatusMessage(denied = false): void {
  const statusEl = document.getElementById("statusMsg")!;
  statusEl.hidden = false;
  statusEl.textContent = userPos ? t("location_found") : denied ? t("location_denied") : t("locating");
}

function placeUserMarker(): void {
  if (!userPos) return;
  const icon = L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [16, 16] });
  if (userMarker) userMarker.remove();
  userMarker = L.marker([userPos.lat, userPos.lng], { icon, zIndexOffset: 1000 }).addTo(map);
  map.setView([userPos.lat, userPos.lng], 13);
}

// -----------------------------------------------------------------------
// Map
// -----------------------------------------------------------------------
function initMap(): void {
  map = L.map("map", { zoomControl: true }).setView([FALLBACK_CENTER.lat, FALLBACK_CENTER.lng], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
}

function pinIcon(kind: TargetType): any {
  const label = kind === "orphan" ? "❤" : "🏠";
  return L.divIcon({
    className: "",
    html: `<div class="marker-pin marker-pin--${kind}"><span>${label}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
  });
}

function clearMarkers(): void {
  markers.forEach((m) => m.remove());
  markers = [];
}

function renderMarkers(): void {
  clearMarkers();
  const items: Array<OrphanDTO | AssociationDTO> = activeTab === "orphan" ? orphans : associations;

  items.forEach((item) => {
    const isOrphan = activeTab === "orphan";
    const name = isOrphan ? (item as OrphanDTO).first_name : (item as AssociationDTO).name;
    const marker = L.marker([item.latitude, item.longitude], { icon: pinIcon(activeTab) }).addTo(map);

    const popupHtml = `
      <div class="popup">
        <h3>${escapeHtml(name)}</h3>
        <p>${escapeHtml(isOrphan ? (item as OrphanDTO).city : (item as AssociationDTO).address)}${
          item.distance_km != null ? " · " + item.distance_km + " km" : ""
        }</p>
        <div class="popup__actions">
          <button class="btn btn--primary" data-action="donate" data-type="${activeTab}" data-id="${item.id}">${t("donate_btn")}</button>
          <button class="btn btn--ghost" data-action="directions" data-lat="${item.latitude}" data-lng="${item.longitude}">${t("directions_btn")}</button>
          <button class="btn btn--ghost" data-action="qr" data-type="${activeTab}" data-id="${item.id}">${t("qr_btn")}</button>
        </div>
      </div>`;
    marker.bindPopup(popupHtml);
    marker.on("popupopen", bindPopupActions);
    (marker as any)._rahmaId = item.id;
    markers.push(marker);
  });
}

function bindPopupActions(): void {
  document.querySelectorAll<HTMLButtonElement>(".leaflet-popup [data-action]").forEach((btn) => {
    btn.addEventListener("click", onCardActionClick);
  });
}

function focusMarker(id: number): void {
  const marker = markers.find((m) => (m as any)._rahmaId === id);
  if (marker) {
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 14), { animate: true });
    marker.openPopup();
  }
}

// -----------------------------------------------------------------------
// List rendering
// -----------------------------------------------------------------------
function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function renderList(): void {
  renderOrphanList();
  renderAssociationList();
  renderMarkers();
}

function renderOrphanList(): void {
  const el = document.getElementById("listOrphans")!;
  if (orphans.length === 0) {
    el.innerHTML = `<div class="status-msg">${t("no_results")}</div>`;
    return;
  }
  el.innerHTML = orphans
    .map((o) => {
      const pct = o.monthly_goal > 0 ? Math.min(100, Math.round((o.amount_raised / o.monthly_goal) * 100)) : 0;
      const photo = o.photo_url || placeholderAvatar(o.first_name);
      return `
      <div class="rcard" data-id="${o.id}" data-type="orphan">
        <img class="rcard__photo" src="${photo}" alt="${escapeHtml(o.first_name)}" />
        <div class="rcard__body">
          <div class="rcard__top">
            <span class="rcard__name">${escapeHtml(o.first_name)}, ${o.age} ${t("years_old")}</span>
            ${o.distance_km != null ? `<span class="rcard__distance">${o.distance_km} km</span>` : ""}
          </div>
          <div class="rcard__meta">${escapeHtml(o.city)}${o.needs ? " · " + escapeHtml(o.needs) : ""}</div>
          <div class="progress"><div class="progress__fill" style="width:${pct}%"></div></div>
          <div class="rcard__actions">
            <button class="btn btn--primary btn--small" data-action="donate" data-type="orphan" data-id="${o.id}">${t("donate_btn")}</button>
            <button class="btn btn--ghost btn--small" data-action="directions" data-lat="${o.latitude}" data-lng="${o.longitude}">${t("directions_btn")}</button>
            <button class="btn btn--ghost btn--small" data-action="qr" data-type="orphan" data-id="${o.id}">${t("qr_btn")}</button>
          </div>
        </div>
      </div>`;
    })
    .join("");
  bindCardEvents(el);
}

function renderAssociationList(): void {
  const el = document.getElementById("listAssociations")!;
  if (associations.length === 0) {
    el.innerHTML = `<div class="status-msg">${t("no_results")}</div>`;
    return;
  }
  el.innerHTML = associations
    .map((a) => {
      const photo = a.logo_url || placeholderAvatar(a.name);
      return `
      <div class="rcard" data-id="${a.id}" data-type="association">
        <img class="rcard__photo" src="${photo}" alt="${escapeHtml(a.name)}" />
        <div class="rcard__body">
          <div class="rcard__top">
            <span class="rcard__name">${escapeHtml(a.name)}</span>
            ${a.distance_km != null ? `<span class="rcard__distance">${a.distance_km} km</span>` : ""}
          </div>
          <div class="rcard__meta">${escapeHtml(a.address)}</div>
          <div class="rcard__actions">
            <button class="btn btn--primary btn--small" data-action="donate" data-type="association" data-id="${a.id}">${t("donate_btn")}</button>
            <button class="btn btn--ghost btn--small" data-action="directions" data-lat="${a.latitude}" data-lng="${a.longitude}">${t("directions_btn")}</button>
            <button class="btn btn--ghost btn--small" data-action="qr" data-type="association" data-id="${a.id}">${t("qr_btn")}</button>
          </div>
        </div>
      </div>`;
    })
    .join("");
  bindCardEvents(el);
}

function placeholderAvatar(seed: string): string {
  // Simple deterministic colored initial avatar via inline SVG data URI — no external image service required.
  const initial = (seed || "?").trim().charAt(0).toUpperCase();
  const colors = ["1F5C4F", "D98E3F", "B5573A", "5B5A4E"];
  const idx = Math.abs(hashCode(seed)) % colors.length;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" rx="28" fill="#${colors[idx]}"/><text x="50%" y="54%" font-family="Inter,sans-serif" font-size="24" fill="white" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

function bindCardEvents(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>(".rcard").forEach((card) => {
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-action]")) return;
      focusMarker(Number(card.dataset.id));
    });
  });
  container.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
    btn.addEventListener("click", onCardActionClick);
  });
}

// -----------------------------------------------------------------------
// Actions: donate / directions / qr
// -----------------------------------------------------------------------
function onCardActionClick(e: Event): void {
  e.stopPropagation();
  const btn = e.currentTarget as HTMLButtonElement;
  const action = btn.dataset.action;

  if (action === "donate") {
    openDonateModal(btn.dataset.type as TargetType, Number(btn.dataset.id));
  } else if (action === "directions") {
    openDirections(Number(btn.dataset.lat), Number(btn.dataset.lng));
  } else if (action === "qr") {
    openQrModal(btn.dataset.type as TargetType, Number(btn.dataset.id));
  }
}

function openDirections(lat: number, lng: number): void {
  // Google Maps deep link — works on desktop (opens Google Maps web)
  // and on mobile (opens the Google Maps app if installed). No API key required.
  const origin = userPos ? `${userPos.lat},${userPos.lng}` : "";
  const url = `https://www.google.com/maps/dir/?api=1${origin ? "&origin=" + origin : ""}&destination=${lat},${lng}&travelmode=driving`;
  window.open(url, "_blank", "noopener");
}

function findTarget(type: TargetType, id: number): OrphanDTO | AssociationDTO | undefined {
  return type === "orphan" ? orphans.find((o) => o.id === id) : associations.find((a) => a.id === id);
}

function openDonateModal(type: TargetType, id: number, viaQr = false): void {
  const target = findTarget(type, id);
  if (!target) return;

  const modal = document.getElementById("donateModal")!;
  const isOrphan = type === "orphan";
  const name = isOrphan ? (target as OrphanDTO).first_name : (target as AssociationDTO).name;
  const photo = isOrphan
    ? (target as OrphanDTO).photo_url || placeholderAvatar(name)
    : (target as AssociationDTO).logo_url || placeholderAvatar(name);

  (document.getElementById("donateTargetPhoto") as HTMLImageElement).src = photo;
  document.getElementById("donateTargetName")!.textContent = isOrphan
    ? `${name}, ${(target as OrphanDTO).age} ${t("years_old")}`
    : name;

  const needsEl = document.getElementById("donateTargetNeeds")!;
  if (isOrphan && (target as OrphanDTO).needs) {
    needsEl.hidden = false;
    needsEl.textContent = `${t("needs_label")}: ${(target as OrphanDTO).needs}`;
  } else if (!isOrphan && (target as AssociationDTO).description) {
    needsEl.hidden = false;
    needsEl.textContent = (target as AssociationDTO).description;
  } else {
    needsEl.hidden = true;
  }

  (document.getElementById("donateTargetType") as HTMLInputElement).value = type;
  (document.getElementById("donateTargetId") as HTMLInputElement).value = String(id);
  (document.getElementById("donateForm") as HTMLFormElement).dataset.viaQr = String(viaQr);

  (document.getElementById("donateForm") as HTMLFormElement).hidden = false;
  document.getElementById("donateSuccess")!.hidden = true;
  (document.getElementById("donateForm") as HTMLFormElement).reset();

  modal.hidden = false;
}

function openQrModal(type: TargetType, id: number): void {
  const target = findTarget(type, id);
  if (!target) return;
  const name = type === "orphan" ? (target as OrphanDTO).first_name : (target as AssociationDTO).name;

  document.getElementById("qrTargetName")!.textContent = name;
  const imgUrl = `${API_BASE}/qr/${type}/${id}`;
  (document.getElementById("qrImage") as HTMLImageElement).src = imgUrl;
  (document.getElementById("qrDownload") as HTMLAnchorElement).href = imgUrl;

  document.getElementById("qrModal")!.hidden = false;
}

function closeModals(): void {
  document.getElementById("donateModal")!.hidden = true;
  document.getElementById("qrModal")!.hidden = true;
}

// -----------------------------------------------------------------------
// Data refresh
// -----------------------------------------------------------------------
async function refreshData(): Promise<void> {
  [orphans, associations] = await Promise.all([fetchOrphans(), fetchAssociations()]);
  renderList();
}

// -----------------------------------------------------------------------
// Deep link from QR scan: /?donate=orphan&id=5
// -----------------------------------------------------------------------
function handleDeepLink(): void {
  const params = new URLSearchParams(window.location.search);
  const type = params.get("donate") as TargetType | null;
  const id = params.get("id");
  if (type && id) {
    // Data might not be loaded yet on first paint — retry briefly.
    const tryOpen = () => {
      if (findTarget(type, Number(id))) {
        openDonateModal(type, Number(id), true);
      } else {
        setTimeout(tryOpen, 300);
      }
    };
    tryOpen();
  }
}

// -----------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------
function wireEvents(): void {
  document.getElementById("locateBtn")!.addEventListener("click", locateUser);

  document.querySelectorAll<HTMLButtonElement>(".lang-btn").forEach((btn) => {
    btn.addEventListener("click", () => setLang(btn.dataset.lang as Lang));
  });

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      tabBtn.classList.add("active");
      activeTab = tabBtn.dataset.target as TargetType;
      document.getElementById("listOrphans")!.hidden = activeTab !== "orphan";
      document.getElementById("listAssociations")!.hidden = activeTab !== "association";
      renderMarkers();
    });
  });

  const radiusRange = document.getElementById("radiusRange") as HTMLInputElement;
  radiusRange.addEventListener("input", () => {
    document.getElementById("radiusValue")!.textContent = `${radiusRange.value} km`;
  });
  radiusRange.addEventListener("change", refreshData);

  document.getElementById("mobileListToggle")!.addEventListener("click", () => {
    document.getElementById("sidePanel")!.classList.toggle("open");
  });

  document.querySelectorAll<HTMLElement>("[data-close]").forEach((el) => {
    el.addEventListener("click", closeModals);
  });

  document.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      (document.getElementById("donationAmount") as HTMLInputElement).value = chip.dataset.amount!;
    });
  });

  document.getElementById("donateForm")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const payload = {
      donor_name: (document.getElementById("donorName") as HTMLInputElement).value || "Anonymous",
      donor_email: (document.getElementById("donorEmail") as HTMLInputElement).value,
      amount: Number((document.getElementById("donationAmount") as HTMLInputElement).value),
      currency: "TND",
      message: (document.getElementById("donationMessage") as HTMLTextAreaElement).value,
      target_type: (document.getElementById("donateTargetType") as HTMLInputElement).value,
      target_id: Number((document.getElementById("donateTargetId") as HTMLInputElement).value),
      via_qr: form.dataset.viaQr === "true",
    };
    try {
      await submitDonation(payload);
      form.hidden = true;
      document.getElementById("donateSuccess")!.hidden = false;
      await refreshData();
    } catch (err) {
      alert("Something went wrong. Please try again.");
    }
  });
}

// -----------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------
async function boot(): Promise<void> {
  initMap();
  wireEvents();
  await loadTranslations(currentLang);
  applyTranslations();
  document.querySelectorAll<HTMLButtonElement>(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === currentLang);
  });
  await refreshData();
  locateUser();
  handleDeepLink();
}

boot();
