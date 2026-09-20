"use strict";
// Rahma — frontend application logic
// Talks to the FastAPI backend, renders the Leaflet map + card list,
// handles i18n (en/fr/ar with RTL), donations, and QR deep links.
// -----------------------------------------------------------------------
// Config / state
// -----------------------------------------------------------------------
const API_BASE = "/api";
const RTL_LANGS = ["ar"];
let currentLang = localStorage.getItem("rahma_lang") || "en";
let translations = {};
let userPos = null;
let map;
let clusterGroup;
let markers = [];
let userMarker = null;
let orphans = [];
let associations = [];
let activeTab = "orphan";
let searchQuery = "";
let sortMode = "distance";
let mobileView = "map";
const FALLBACK_CENTER = { lat: 36.8065, lng: 10.1815 }; // Tunis
// -----------------------------------------------------------------------
// i18n
// -----------------------------------------------------------------------
async function loadTranslations(lang) {
    const res = await fetch(`i18n/${lang}.json`);
    translations = await res.json();
}
function t(key) {
    return translations[key] || key;
}
function applyTranslations() {
    document.documentElement.lang = currentLang;
    document.documentElement.dir = RTL_LANGS.includes(currentLang) ? "rtl" : "ltr";
    document.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        el.textContent = t(key);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        const key = el.getAttribute("data-i18n-placeholder");
        el.placeholder = t(key);
    });
    document.querySelectorAll(".lang-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.lang === currentLang);
    });
}
async function setLang(lang) {
    currentLang = lang;
    localStorage.setItem("rahma_lang", lang);
    await loadTranslations(lang);
    applyTranslations();
    setMobileView(mobileView); // re-sync label text (the generic i18n pass just overwrote it)
    // Re-render dynamic content that embeds translated strings
    renderList();
    updateStatusMessage();
}
// -----------------------------------------------------------------------
// API calls
// -----------------------------------------------------------------------
async function fetchOrphans() {
    const params = new URLSearchParams();
    if (userPos) {
        params.set("lat", String(userPos.lat));
        params.set("lng", String(userPos.lng));
        const radius = document.getElementById("radiusRange").value;
        params.set("radius_km", radius);
    }
    const res = await fetch(`${API_BASE}/orphans?${params.toString()}`);
    return res.json();
}
async function fetchAssociations() {
    const params = new URLSearchParams();
    if (userPos) {
        params.set("lat", String(userPos.lat));
        params.set("lng", String(userPos.lng));
        const radius = document.getElementById("radiusRange").value;
        params.set("radius_km", radius);
    }
    const res = await fetch(`${API_BASE}/associations?${params.toString()}`);
    return res.json();
}
async function submitDonation(payload) {
    const res = await fetch(`${API_BASE}/donations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!res.ok)
        throw new Error("Donation failed");
    return res.json();
}
// -----------------------------------------------------------------------
// Geolocation
// -----------------------------------------------------------------------
function locateUser() {
    const statusEl = document.getElementById("statusMsg");
    statusEl.hidden = false;
    statusEl.textContent = t("locating");
    if (!navigator.geolocation) {
        userPos = null;
        updateStatusMessage(true);
        refreshData();
        return;
    }
    navigator.geolocation.getCurrentPosition((pos) => {
        userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        updateStatusMessage();
        placeUserMarker();
        refreshData();
    }, () => {
        userPos = null;
        updateStatusMessage(true);
        refreshData();
    }, { enableHighAccuracy: true, timeout: 8000 });
}
function updateStatusMessage(denied = false) {
    const statusEl = document.getElementById("statusMsg");
    statusEl.hidden = false;
    statusEl.textContent = userPos ? t("location_found") : denied ? t("location_denied") : t("locating");
}
function placeUserMarker() {
    if (!userPos)
        return;
    const icon = L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [16, 16] });
    if (userMarker)
        userMarker.remove();
    userMarker = L.marker([userPos.lat, userPos.lng], { icon, zIndexOffset: 1000 }).addTo(map);
    map.setView([userPos.lat, userPos.lng], 13);
}
// -----------------------------------------------------------------------
// Map
// -----------------------------------------------------------------------
function initMap() {
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
        }
        else {
            throw new Error("markercluster plugin not available");
        }
    }
    catch (err) {
        console.warn("Marker clustering unavailable, falling back to plain markers:", err);
        clusterGroup = L.layerGroup();
    }
    map.addLayer(clusterGroup);
}
function pinIcon(kind) {
    const label = kind === "orphan" ? "❤" : "🏠";
    return L.divIcon({
        className: "",
        html: `<div class="marker-pin marker-pin--${kind}"><span>${label}</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 30],
        popupAnchor: [0, -28],
    });
}
function clearMarkers() {
    clusterGroup.clearLayers();
    markers = [];
}
function renderMarkers() {
    clearMarkers();
    const items = activeTab === "orphan" ? getFilteredOrphans() : getFilteredAssociations();
    items.forEach((item) => {
        const isOrphan = activeTab === "orphan";
        const name = isOrphan ? item.first_name : item.name;
        const marker = L.marker([item.latitude, item.longitude], { icon: pinIcon(activeTab) });
        const popupHtml = `
      <div class="popup">
        <h3>${escapeHtml(name)}</h3>
        <p>${escapeHtml(isOrphan ? item.city : item.address)}${item.distance_km != null ? " · " + item.distance_km + " km" : ""}</p>
        <div class="popup__actions">
          <button class="btn btn--primary" data-action="donate" data-type="${activeTab}" data-id="${item.id}">${t("donate_btn")}</button>
          <button class="btn btn--ghost" data-action="directions" data-lat="${item.latitude}" data-lng="${item.longitude}">${t("directions_btn")}</button>
          <button class="btn btn--ghost" data-action="qr" data-type="${activeTab}" data-id="${item.id}">${t("qr_btn")}</button>
        </div>
      </div>`;
        marker.bindPopup(popupHtml);
        marker.on("popupopen", bindPopupActions);
        marker._rahmaId = item.id;
        markers.push(marker);
        clusterGroup.addLayer(marker);
    });
}
function bindPopupActions() {
    document.querySelectorAll(".leaflet-popup [data-action]").forEach((btn) => {
        btn.addEventListener("click", onCardActionClick);
    });
}
function focusMarker(id) {
    const marker = markers.find((m) => m._rahmaId === id);
    if (marker) {
        if (clusterGroup.zoomToShowLayer) {
            clusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
        }
        else {
            map.setView(marker.getLatLng(), Math.max(map.getZoom(), 14), { animate: true });
            marker.openPopup();
        }
    }
}
// -----------------------------------------------------------------------
// List rendering
// -----------------------------------------------------------------------
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
}
function getFilteredOrphans() {
    let list = orphans;
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter((o) => o.first_name.toLowerCase().includes(q) || o.city.toLowerCase().includes(q));
    }
    list = [...list];
    if (sortMode === "name") {
        list.sort((a, b) => a.first_name.localeCompare(b.first_name));
    }
    else if (sortMode === "need") {
        list.sort((a, b) => {
            const pctA = a.monthly_goal > 0 ? a.amount_raised / a.monthly_goal : 1;
            const pctB = b.monthly_goal > 0 ? b.amount_raised / b.monthly_goal : 1;
            return pctA - pctB;
        });
    }
    // "distance" mode: keep the backend's distance-sorted order as-is.
    return list;
}
function getFilteredAssociations() {
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
function renderList() {
    renderOrphanList();
    renderAssociationList();
    renderMarkers();
    updateResultCount();
}
function updateResultCount() {
    const el = document.getElementById("resultCount");
    const count = activeTab === "orphan" ? getFilteredOrphans().length : getFilteredAssociations().length;
    const label = t(activeTab === "orphan" ? "tab_orphans" : "tab_associations");
    el.textContent = `${count} ${label.toLowerCase()}`;
}
function renderOrphanList() {
    const el = document.getElementById("listOrphans");
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
function renderAssociationList() {
    const el = document.getElementById("listAssociations");
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
function placeholderAvatar(seed) {
    // Simple deterministic colored initial avatar via inline SVG data URI — no external image service required.
    const initial = (seed || "?").trim().charAt(0).toUpperCase();
    const colors = ["1F5C4F", "D98E3F", "B5573A", "5B5A4E"];
    const idx = Math.abs(hashCode(seed)) % colors.length;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" rx="28" fill="#${colors[idx]}"/><text x="50%" y="54%" font-family="Inter,sans-serif" font-size="24" fill="white" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h << 5) - h + s.charCodeAt(i);
    return h;
}
function bindCardEvents(container) {
    container.querySelectorAll(".rcard").forEach((card) => {
        card.addEventListener("click", (e) => {
            if (e.target.closest("[data-action]"))
                return;
            focusMarker(Number(card.dataset.id));
            if (isMobileWidth())
                setMobileView("map");
        });
    });
    container.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", onCardActionClick);
    });
}
// -----------------------------------------------------------------------
// Actions: donate / directions / qr
// -----------------------------------------------------------------------
function onCardActionClick(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const action = btn.dataset.action;
    if (action === "donate") {
        openDonateModal(btn.dataset.type, Number(btn.dataset.id));
    }
    else if (action === "directions") {
        openDirections(Number(btn.dataset.lat), Number(btn.dataset.lng));
    }
    else if (action === "qr") {
        openQrModal(btn.dataset.type, Number(btn.dataset.id));
    }
}
function openDirections(lat, lng) {
    // Google Maps deep link — works on desktop (opens Google Maps web)
    // and on mobile (opens the Google Maps app if installed). No API key required.
    const origin = userPos ? `${userPos.lat},${userPos.lng}` : "";
    const url = `https://www.google.com/maps/dir/?api=1${origin ? "&origin=" + origin : ""}&destination=${lat},${lng}&travelmode=driving`;
    window.open(url, "_blank", "noopener");
}
function findTarget(type, id) {
    return type === "orphan" ? orphans.find((o) => o.id === id) : associations.find((a) => a.id === id);
}
function openDonateModal(type, id, viaQr = false) {
    const target = findTarget(type, id);
    if (!target)
        return;
    const modal = document.getElementById("donateModal");
    const isOrphan = type === "orphan";
    const name = isOrphan ? target.first_name : target.name;
    const photo = isOrphan
        ? target.photo_url || placeholderAvatar(name)
        : target.logo_url || placeholderAvatar(name);
    document.getElementById("donateTargetPhoto").src = photo;
    document.getElementById("donateTargetName").textContent = isOrphan
        ? `${name}, ${target.age} ${t("years_old")}`
        : name;
    const needsEl = document.getElementById("donateTargetNeeds");
    if (isOrphan && target.needs) {
        needsEl.hidden = false;
        needsEl.textContent = `${t("needs_label")}: ${target.needs}`;
    }
    else if (!isOrphan && target.description) {
        needsEl.hidden = false;
        needsEl.textContent = target.description;
    }
    else {
        needsEl.hidden = true;
    }
    document.getElementById("donateTargetType").value = type;
    document.getElementById("donateTargetId").value = String(id);
    document.getElementById("donateForm").dataset.viaQr = String(viaQr);
    document.getElementById("donateForm").hidden = false;
    document.getElementById("donateSuccess").hidden = true;
    document.getElementById("donateForm").reset();
    modal.hidden = false;
}
function openQrModal(type, id) {
    const target = findTarget(type, id);
    if (!target)
        return;
    const name = type === "orphan" ? target.first_name : target.name;
    document.getElementById("qrTargetName").textContent = name;
    const imgUrl = `${API_BASE}/qr/${type}/${id}`;
    document.getElementById("qrImage").src = imgUrl;
    document.getElementById("qrDownload").href = imgUrl;
    document.getElementById("qrDownload").download = `rahma-qr-${type}-${id}.png`;
    const shareBtn = document.getElementById("qrShare");
    shareBtn.hidden = !navigator.share;
    shareBtn.dataset.type = type;
    shareBtn.dataset.id = String(id);
    shareBtn.dataset.name = name;
    document.getElementById("qrModal").hidden = false;
}
async function shareQr(type, id, name) {
    const imgUrl = `${window.location.origin}${API_BASE}/qr/${type}/${id}`;
    const linkUrl = `${window.location.origin}/?donate=${type}&id=${id}`;
    const nav = navigator;
    try {
        const resp = await fetch(imgUrl);
        const blob = await resp.blob();
        const file = new File([blob], `rahma-qr-${type}-${id}.png`, { type: "image/png" });
        if (nav.canShare && nav.canShare({ files: [file] })) {
            await nav.share({ files: [file], title: name, text: name });
            return;
        }
    }
    catch {
        /* fall through to link share below */
    }
    if (nav.share) {
        try {
            await nav.share({ title: name, url: linkUrl });
        }
        catch {
            /* user cancelled — no action needed */
        }
    }
}
function closeModals() {
    document.getElementById("donateModal").hidden = true;
    document.getElementById("qrModal").hidden = true;
}
// -----------------------------------------------------------------------
// Data refresh
// -----------------------------------------------------------------------
async function refreshData() {
    [orphans, associations] = await Promise.all([fetchOrphans(), fetchAssociations()]);
    renderList();
}
// -----------------------------------------------------------------------
// Deep link from QR scan: /?donate=orphan&id=5
// -----------------------------------------------------------------------
function handleDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const type = params.get("donate");
    const id = params.get("id");
    if (type && id) {
        // Data might not be loaded yet on first paint — retry briefly.
        const tryOpen = () => {
            if (findTarget(type, Number(id))) {
                openDonateModal(type, Number(id), true);
            }
            else {
                setTimeout(tryOpen, 300);
            }
        };
        tryOpen();
    }
}
// -----------------------------------------------------------------------
// Mobile view toggle: map and list are two full-screen views, never both
// visible together — tapping the button hard-switches between them.
// -----------------------------------------------------------------------
function setMobileView(view) {
    mobileView = view;
    document.querySelector(".layout").classList.toggle("show-list", view === "list");
    const toggleBtn = document.getElementById("mobileListToggle");
    toggleBtn.textContent = view === "list" ? t("show_map") : t("show_list");
    if (view === "map") {
        // Leaflet needs a nudge after its container was hidden (display:none)
        // and becomes visible again, or tiles render blank/mis-sized.
        setTimeout(() => map && map.invalidateSize(), 60);
    }
}
const isMobileWidth = () => window.matchMedia("(max-width: 860px)").matches;
// -----------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------
function wireEvents() {
    document.getElementById("locateBtn").addEventListener("click", locateUser);
    document.querySelectorAll(".lang-btn").forEach((btn) => {
        btn.addEventListener("click", () => setLang(btn.dataset.lang));
    });
    document.querySelectorAll(".tab").forEach((tabBtn) => {
        tabBtn.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
            tabBtn.classList.add("active");
            activeTab = tabBtn.dataset.target;
            document.getElementById("listOrphans").hidden = activeTab !== "orphan";
            document.getElementById("listAssociations").hidden = activeTab !== "association";
            renderMarkers();
            updateResultCount();
        });
    });
    const radiusRange = document.getElementById("radiusRange");
    radiusRange.addEventListener("input", () => {
        document.getElementById("radiusValue").textContent = `${radiusRange.value} km`;
    });
    radiusRange.addEventListener("change", refreshData);
    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value.trim();
        renderList();
    });
    const sortSelect = document.getElementById("sortSelect");
    sortSelect.addEventListener("change", () => {
        sortMode = sortSelect.value;
        renderList();
    });
    document.getElementById("recenterFab").addEventListener("click", () => {
        if (userPos) {
            map.flyTo([userPos.lat, userPos.lng], 15);
        }
        else {
            locateUser();
        }
    });
    document.getElementById("mobileListToggle").addEventListener("click", () => {
        setMobileView(mobileView === "list" ? "map" : "list");
    });
    document.querySelectorAll("[data-close]").forEach((el) => {
        el.addEventListener("click", closeModals);
    });
    document.getElementById("qrShare").addEventListener("click", (e) => {
        const btn = e.currentTarget;
        shareQr(btn.dataset.type, Number(btn.dataset.id), btn.dataset.name || "");
    });
    document.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
            chip.classList.add("active");
            document.getElementById("donationAmount").value = chip.dataset.amount;
        });
    });
    document.getElementById("donateForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const payload = {
            donor_name: document.getElementById("donorName").value || "Anonymous",
            donor_email: document.getElementById("donorEmail").value,
            amount: Number(document.getElementById("donationAmount").value),
            currency: "TND",
            message: document.getElementById("donationMessage").value,
            target_type: document.getElementById("donateTargetType").value,
            target_id: Number(document.getElementById("donateTargetId").value),
            via_qr: form.dataset.viaQr === "true",
        };
        try {
            await submitDonation(payload);
            form.hidden = true;
            document.getElementById("donateSuccess").hidden = false;
            await refreshData();
        }
        catch (err) {
            alert("Something went wrong. Please try again.");
        }
    });
}
// -----------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------
async function boot() {
    try {
        initMap();
    }
    catch (err) {
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
    }
    catch (err) {
        console.error("Failed wiring UI events:", err);
    }
    try {
        await loadTranslations(currentLang);
    }
    catch (err) {
        console.error("Failed loading translations, falling back to raw keys:", err);
    }
    applyTranslations();
    setMobileView(mobileView);
    document.querySelectorAll(".lang-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.lang === currentLang);
    });
    try {
        await refreshData();
    }
    catch (err) {
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
