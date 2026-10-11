const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
const formatDate = value => {
  if (!value) return "Date TBA";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en", { day:"numeric", month:"short", year:"numeric" });
};
let toastTimer;
function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type":"application/json" } : {}), ...(options.headers || {}) }
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}
async function currentUser() { return (await api("/api/me")).user; }
function typeIcon(type) {
  return ({ Course:"▣", Workshop:"✳", Competition:"◇", Event:"✦", Volunteering:"♡", Scholarship:"✧", Other:"↗" })[type] || "↗";
}
function opportunityCard(item, { showBookmark = true, showDelete = false } = {}) {
  const image = item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('image-failed');this.remove()">` : "";
  const deadline = item.deadline ? `Deadline ${formatDate(item.deadline)}` : "Deadline not listed";
  const location = item.mode === "Online" ? "Online" : (item.location || item.mode);
  return `<article class="opportunity-card" data-id="${item.id}">
    <div class="card-image ${image ? "" : "image-failed"}">${image}<span class="card-type"><span>${typeIcon(item.type)}</span>${escapeHtml(item.type)}</span>${item.bookmarked ? '<span class="saved-ribbon">SAVED</span>' : ""}</div>
    <div class="card-body"><div class="card-subject">${escapeHtml(item.subject)}</div><h3>${escapeHtml(item.title)}</h3><p class="card-description">${escapeHtml(item.description)}</p>
    <div class="card-meta"><span><span class="meta-icon">◷</span>${escapeHtml(formatDate(item.startDate))}</span><span><span class="meta-icon">⌖</span>${escapeHtml(location)}</span></div>
    <div class="card-footer"><span class="deadline">${escapeHtml(deadline)}</span><div class="card-actions">${showBookmark ? `<button class="icon-button bookmark-button ${item.bookmarked ? "is-saved" : ""}" data-bookmark="${item.id}" aria-label="${item.bookmarked ? "Remove saved opportunity" : "Save opportunity"}" title="${item.bookmarked ? "Remove saved" : "Save"}">${item.bookmarked ? "♥" : "♡"}</button>` : ""}${showDelete ? `<button class="icon-button delete-button" data-delete="${item.id}" aria-label="Delete your listing" title="Delete listing">×</button>` : ""}<a class="card-link" href="${item.url ? escapeHtml(item.url) : "#"}" ${item.url ? 'target="_blank" rel="noopener noreferrer"' : 'data-no-link="true"'}>${item.url ? "View details ↗" : "Details soon ↗"}</a></div></div></div>
  </article>`;
}
async function toggleBookmark(id) {
  try {
    const result = await api(`/api/opportunities/${id}/bookmark`, { method:"POST" });
    toast(result.bookmarked ? "Saved to your opportunities." : "Removed from saved opportunities.");
    if (typeof loadHome === "function") await loadHome();
    if (typeof loadDashboard === "function") await loadDashboard();
  } catch (error) {
    if (error.message.includes("log in")) location.href = "/login.html";
    else toast(error.message);
  }
}
function bindCardActions(root) {
  $$("[data-bookmark]", root).forEach(btn => btn.addEventListener("click", () => toggleBookmark(btn.dataset.bookmark)));
  $$("[data-no-link]", root).forEach(a => a.addEventListener("click", e => { e.preventDefault(); toast("The organizer has not added a details link yet."); }));
  $$("[data-delete]", root).forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("Delete this opportunity? This cannot be undone.")) return;
    try { await api(`/api/opportunities/${btn.dataset.delete}`, { method:"DELETE" }); toast("Listing deleted."); await loadDashboard(); }
    catch (error) { toast(error.message); }
  }));
}
async function loadHome() {
  const grid = $("#opportunityGrid");
  if (!grid) return;
  const params = new URLSearchParams();
  const search = $("#searchInput")?.value.trim();
  const type = $("#typeFilter")?.value;
  const subject = $("#subjectFilter")?.value;
  const mode = $("#modeFilter")?.value;
  if (search) params.set("search", search);
  if (type && type !== "All types") params.set("type", type);
  if (subject && subject !== "All subjects") params.set("subject", subject);
  if (mode && mode !== "Any format") params.set("mode", mode);
  try {
    const data = await api(`/api/opportunities?${params.toString()}`);
    $("#resultsCount").textContent = `${data.opportunities.length} ${data.opportunities.length === 1 ? "opportunity" : "opportunities"} to explore`;
    grid.innerHTML = data.opportunities.map(item => opportunityCard(item)).join("");
    $("#emptyState")?.classList.toggle("hidden", data.opportunities.length !== 0);
    grid.classList.toggle("hidden", data.opportunities.length === 0);
    bindCardActions(grid);
  } catch (error) {
    grid.innerHTML = `<div class="loading-card">Could not load opportunities. Please refresh the page.</div>`;
    $("#resultsCount").textContent = error.message;
  }
}
function debounce(fn, wait = 250) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; }
function initHome() {
  if (!$("#opportunityGrid")) return;
  ["#searchInput","#typeFilter","#subjectFilter","#modeFilter"].forEach(selector => $(selector)?.addEventListener(selector === "#searchInput" ? "input" : "change", selector === "#searchInput" ? debounce(loadHome) : loadHome));
  const reset = () => { $("#searchInput").value = ""; $("#typeFilter").selectedIndex = 0; $("#subjectFilter").selectedIndex = 0; $("#modeFilter").selectedIndex = 0; loadHome(); };
  $("#clearFilters")?.addEventListener("click", reset); $("#emptyReset")?.addEventListener("click", reset);
  loadHome();
  currentUser().then(user => {
    const nav = $("#navActions");
    const plans = $("#plans");
    const plansNav = $("#plansNav");
    const publisher = !!user && ["organization", "academy"].includes(user.role);
    // Guests see sign-up prompts; providers see plans; learners never see provider pricing.
    $$(".guest-only").forEach(el => el.classList.toggle("hidden", !!user));
    plans?.classList.toggle("hidden", !publisher);
    plansNav?.classList.toggle("hidden", !publisher);
    if (user && nav) nav.innerHTML = `<a class="text-link" href="/dashboard.html">Hi, ${escapeHtml(user.name.split(" ")[0])}</a><a class="button button-small" href="/dashboard.html">My dashboard <span>↗</span></a>`;
  }).catch(() => {});
}
function initAuth() {
  $("#signupForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const form = e.currentTarget, errorEl = $("#signupError"), button = $("button[type=submit]", form);
    errorEl.textContent = "";
    const interests = $$('input[name="interests"]:checked', form).map(input => input.value);
    const payload = { name:form.name.value, email:form.email.value, password:form.password.value, role:form.role.value, interests };
    button.disabled = true; button.textContent = "Creating account…";
    try { await api("/api/signup", { method:"POST", body:JSON.stringify(payload) }); location.href = "/dashboard.html"; }
    catch (error) { errorEl.textContent = error.message; button.disabled = false; button.innerHTML = 'Create account <span>↗</span>'; }
  });
  $("#loginForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const form = e.currentTarget, errorEl = $("#loginError"), button = $("button[type=submit]", form);
    errorEl.textContent = ""; button.disabled = true; button.textContent = "Logging in…";
    try { await api("/api/login", { method:"POST", body:JSON.stringify({ email:form.email.value, password:form.password.value }) }); location.href = "/dashboard.html"; }
    catch (error) { errorEl.textContent = error.message; button.disabled = false; button.innerHTML = 'Log in <span>↗</span>'; }
  });
}
let dashboardUser = null, dashboardView = "all";
async function initDashboard() {
  if (!$("#dashboardGrid")) return;
  try { dashboardUser = await currentUser(); }
  catch { location.href = "/login.html"; return; }
  if (!dashboardUser) { location.href = "/login.html"; return; }
  $("#welcomeName").textContent = dashboardUser.name.split(" ")[0];
  const publisher = ["organization","academy"].includes(dashboardUser.role);
  $("#roleBadge").textContent = publisher ? `${dashboardUser.role.toUpperCase()} SPACE` : "LEARNER SPACE";
  $("#welcomeSubtitle").textContent = publisher ? "Share opportunities and connect with learners." : "Save opportunities and find your next step.";
  $("#dashboardPlans")?.classList.toggle("hidden", !publisher);
  $("#savedTab").classList.toggle("hidden", publisher);
  $("#mineTab").classList.toggle("hidden", !publisher);
  $("#createTab").classList.toggle("hidden", !publisher);
  $("#logoutButton")?.addEventListener("click", async () => { try { await api("/api/logout", { method:"POST" }); } finally { location.href = "/"; } });
  $$(".tab").forEach(tab => tab.addEventListener("click", () => setDashboardView(tab.dataset.view)));
  $("#opportunityForm")?.addEventListener("submit", publishOpportunity);
  await loadDashboard();
}
function setDashboardView(view) {
  dashboardView = view;
  $$(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === view));
  $("#publishPanel").classList.toggle("hidden", view !== "create");
  $(".dashboard-content").classList.toggle("hidden", view === "create");
  loadDashboard();
  if (view === "create") $("#publishPanel").scrollIntoView({ behavior:"smooth", block:"start" });
}
async function loadDashboard() {
  if (!dashboardUser) return;
  const grid = $("#dashboardGrid"), empty = $("#dashboardEmpty");
  try {
    let data, options = {};
    if (dashboardView === "saved") data = await api("/api/bookmarks");
    else if (dashboardView === "mine") {
      data = await api("/api/opportunities");
      data.opportunities = data.opportunities.filter(item => item.creatorId === dashboardUser.id);
      options = { showBookmark:false, showDelete:true };
    } else data = await api("/api/opportunities");
    const items = data.opportunities;
    $("#dashboardCount").textContent = `${items.length} ${items.length === 1 ? "opportunity" : "opportunities"}`;
    grid.innerHTML = items.map(item => opportunityCard(item, options)).join("");
    grid.classList.toggle("hidden", items.length === 0);
    empty.classList.toggle("hidden", items.length !== 0);
    bindCardActions(grid);
  } catch (error) { toast(error.message); }
}
async function publishOpportunity(e) {
  e.preventDefault();
  const form = e.currentTarget, button = $("button[type=submit]", form), errorEl = $("#publishError");
  errorEl.textContent = "";
  const payload = Object.fromEntries(new FormData(form).entries());
  button.disabled = true; button.textContent = "Publishing…";
  try {
    await api("/api/opportunities", { method:"POST", body:JSON.stringify(payload) });
    form.reset(); toast("Your opportunity is live.");
    dashboardView = "mine"; setDashboardView("mine");
  } catch (error) { errorEl.textContent = error.message; }
  finally { button.disabled = false; button.innerHTML = 'Publish opportunity <span>↗</span>'; }
}
document.addEventListener("DOMContentLoaded", () => { initHome(); initAuth(); initDashboard(); });

// Demo checkout interactions (no real payment is processed).
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-demo-pay]');
  if (trigger) {
    const dialog = document.getElementById('demoPayment');
    const planName = document.getElementById('demoPlanName');
    if (dialog && planName) { planName.textContent = trigger.getAttribute('data-demo-pay'); dialog.showModal(); }
  }
  if (event.target && event.target.id === 'confirmDemoPayment') {
    const result = document.getElementById('demoPaymentResult');
    if (result) result.textContent = 'Demo only: payment gateway is not connected. No charge was made.';
  }
});
