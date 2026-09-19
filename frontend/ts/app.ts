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
let clusterGroup: any;
let markers: any[] = [];
let userMarker: any = null;

let orphans: OrphanDTO[] = [];
let associations: AssociationDTO[] = [];
let activeTab: TargetType = "orphan";
let searchQuery = "";
let sortMode: "distance" | "need" | "name" = "distance";
let sheetState: "peek" | "open" = "peek";

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
  setSheetState(sheetState); // re-sync label text (the generic i18n pass just overwrote it)
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
  // CartoDB Voyager — a warmer, more legible basemap than stock OSM tiles.
  // Free, no API key required.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxZoom: 20,
    subdomains: "abcd",
  }).addTo(map);

  // Clustering is a nice-to-have: if the plugin CDN is slow/blocked, fall
  // back to a plain layer group so a single script failure can't take the
  // whole app down. clearLayers/addLayer exist on both, so nothing else
  // in the code needs to know which one it got.
  try {
    if (typeof L.markerClusterGroup === "function") {
      clusterGroup = L.markerClusterGroup({ maxClusterRadius: 48, spiderfyOnMaxZoom: true });
    } else {
      throw new Error("markercluster plugin not available");
    }
  } catch (err) {
    console.warn("Marker clustering unavailable, falling back to plain markers:", err);
    clusterGroup = L.layerGroup();
  }
  map.addLayer(clusterGroup);
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
  clusterGroup.clearLayers();
  markers = [];
}

function renderMarkers(): void {
  clearMarkers();
  const items: Array<OrphanDTO | AssociationDTO> = activeTab === "orphan" ? getFilteredOrphans() : getFilteredAssociations();

  items.forEach((item) => {
    const isOrphan = activeTab === "orphan";
    const name = isOrphan ? (item as OrphanDTO).first_name : (item as AssociationDTO).name;
    const marker = L.marker([item.latitude, item.longitude], { icon: pinIcon(activeTab) });

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
    clusterGroup.addLayer(marker);
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
    if (clusterGroup.zoomToShowLayer) {
      clusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
    } else {
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 14), { animate: true });
      marker.openPopup();
    }
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

function getFilteredOrphans(): OrphanDTO[] {
  let list = orphans;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter((o) => o.first_name.toLowerCase().includes(q) || o.city.toLowerCase().includes(q));
  }
  list = [...list];
  if (sortMode === "name") {
    list.sort((a, b) => a.first_name.localeCompare(b.first_name));
  } else if (sortMode === "need") {
    list.sort((a, b) => {
      const pctA = a.monthly_goal > 0 ? a.amount_raised / a.monthly_goal : 1;
      const pctB = b.monthly_goal > 0 ? b.amount_raised / b.monthly_goal : 1;
      return pctA - pctB;
    });
  }
  // "distance" mode: keep the backend's distance-sorted order as-is.
  return list;
}

function getFilteredAssociations(): AssociationDTO[] {
  let list = associations;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter((a) => a.name.toLowerCase().includes(q) || a.address.toLowerCase().includes(q));
  }
  list = [...list];
  if (sortMode === "name") {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return list;
}

function renderList(): void {
  renderOrphanList();
  renderAssociationList();
  renderMarkers();
  updateResultCount();
}

function updateResultCount(): void {
  const el = document.getElementById("resultCount")!;
  const count = activeTab === "orphan" ? getFilteredOrphans().length : getFilteredAssociations().length;
  const label = t(activeTab === "orphan" ? "tab_orphans" : "tab_associations");
  el.textContent = `${count} ${label.toLowerCase()}`;
}

function renderOrphanList(): void {
  const el = document.getElementById("listOrphans")!;
  const list = getFilteredOrphans();
  if (list.length === 0) {
    el.innerHTML = `<div class="status-msg">${t("no_results")}</div>`;
    return;
  }
  el.innerHTML = list
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
  const list = getFilteredAssociations();
  if (list.length === 0) {
    el.innerHTML = `<div class="status-msg">${t("no_results")}</div>`;
    return;
  }
  el.innerHTML = list
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
  (document.getElementById("qrDownload") as HTMLAnchorElement).download = `rahma-qr-${type}-${id}.png`;

  const shareBtn = document.getElementById("qrShare") as HTMLButtonElement;
  shareBtn.hidden = !(navigator as any).share;
  shareBtn.dataset.type = type;
  shareBtn.dataset.id = String(id);
  shareBtn.dataset.name = name;

  document.getElementById("qrModal")!.hidden = false;
}

async function shareQr(type: TargetType, id: number, name: string): Promise<void> {
  const imgUrl = `${window.location.origin}${API_BASE}/qr/${type}/${id}`;
  const linkUrl = `${window.location.origin}/?donate=${type}&id=${id}`;
  const nav = navigator as any;

  try {
    const resp = await fetch(imgUrl);
    const blob = await resp.blob();
    const file = new File([blob], `rahma-qr-${type}-${id}.png`, { type: "image/png" });
    if (nav.canShare && nav.canShare({ files: [file] })) {
      await nav.share({ files: [file], title: name, text: name });
      return;
    }
  } catch {
    /* fall through to link share below */
  }

  if (nav.share) {
    try {
      await nav.share({ title: name, url: linkUrl });
    } catch {
      /* user cancelled — no action needed */
    }
  }
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
// Mobile bottom sheet (drag handle + tap-to-toggle)
// -----------------------------------------------------------------------
function setSheetState(state: "peek" | "open"): void {
  sheetState = state;
  const panel = document.getElementById("sidePanel")!;
  panel.classList.toggle("open", state === "open");
  const toggleBtn = document.getElementById("mobileListToggle")!;
  toggleBtn.textContent = state === "open" ? t("show_map") : t("show_list");
}

function wireBottomSheet(): void {
  const panel = document.getElementById("sidePanel")!;
  const handle = document.getElementById("panelDrag")!;
  let startY = 0;
  let peekPx = 0;
  let dragging = false;

  const onPointerDown = (e: PointerEvent) => {
    startY = e.clientY;
    peekPx = panel.offsetHeight - 112;
    dragging = true;
    panel.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const delta = e.clientY - startY;
    const base = sheetState === "open" ? 0 : peekPx;
    const next = Math.min(peekPx, Math.max(0, base + delta));
    panel.style.transform = `translateY(${next}px)`;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("dragging");
    panel.style.transform = "";
    const totalDelta = e.clientY - startY;
    if (Math.abs(totalDelta) < 6) {
      setSheetState(sheetState === "open" ? "peek" : "open");
    } else {
      const base = sheetState === "open" ? 0 : peekPx;
      const finalPx = Math.min(peekPx, Math.max(0, base + totalDelta));
      setSheetState(finalPx < peekPx / 2 ? "open" : "peek");
    }
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerUp);
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
      updateResultCount();
    });
  });

  const radiusRange = document.getElementById("radiusRange") as HTMLInputElement;
  radiusRange.addEventListener("input", () => {
    document.getElementById("radiusValue")!.textContent = `${radiusRange.value} km`;
  });
  radiusRange.addEventListener("change", refreshData);

  const searchInput = document.getElementById("searchInput") as HTMLInputElement;
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    renderList();
  });

  const sortSelect = document.getElementById("sortSelect") as HTMLSelectElement;
  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value as typeof sortMode;
    renderList();
  });

  document.getElementById("recenterFab")!.addEventListener("click", () => {
    if (userPos) {
      map.flyTo([userPos.lat, userPos.lng], 15);
    } else {
      locateUser();
    }
  });

  wireBottomSheet();

  document.getElementById("mobileListToggle")!.addEventListener("click", () => {
    setSheetState(sheetState === "open" ? "peek" : "open");
  });

  document.querySelectorAll<HTMLElement>("[data-close]").forEach((el) => {
    el.addEventListener("click", closeModals);
  });

  document.getElementById("qrShare")!.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    shareQr(btn.dataset.type as TargetType, Number(btn.dataset.id), btn.dataset.name || "");
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
  try {
    initMap();
  } catch (err) {
    // If Leaflet itself failed to load (CDN blocked/offline), show a clear
    // message instead of a silently blank map area.
    console.error("Map failed to initialize:", err);
    const mapEl = document.getElementById("map");
    if (mapEl) {
      mapEl.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:20px;text-align:center;color:#5B5A4E;font-family:sans-serif;">Map failed to load — check your internet connection and reload the page.</div>';
    }
  }

  try {
    wireEvents();
  } catch (err) {
    console.error("Failed wiring UI events:", err);
  }

  try {
    await loadTranslations(currentLang);
  } catch (err) {
    console.error("Failed loading translations, falling back to raw keys:", err);
  }
  applyTranslations();
  setSheetState(sheetState);
  document.querySelectorAll<HTMLButtonElement>(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === currentLang);
  });

  try {
    await refreshData();
  } catch (err) {
    console.error("Failed loading orphans/associations:", err);
    const statusEl = document.getElementById("statusMsg");
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = "Could not load data from the server. Check that the backend is running and reload.";
    }
  }

  locateUser();
  handleDeepLink();
}

boot();
