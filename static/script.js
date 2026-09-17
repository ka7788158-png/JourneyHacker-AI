/* ==========================================================================
   JourneyHacker — scripts.js
   ==========================================================================
   BACKEND CONTRACT (see README section in the chat response for details):

   POST {API_BASE}/api/plan
   body: { "query": "<natural language trip request>", "thread_id": "<string|null>" }
   response (mirrors run_travel_agent() in backend.py):
   {
     "thread_id": "user_xxxx",
     "answer": "string — final formatted response from the LLM",
     "flight_results": "string — formatted flight blocks or an error/empty message",
     "hotel_results": "string — Tavily search results as text",
     "itinerary": "string — day-by-day itinerary text from the LLM",
     "llm_calls": 3
   }

   backend.py currently exposes only a Python function, not a FastAPI route.
   This file talks to the placeholder endpoint above — see the minimal
   FastAPI wrapper provided alongside this frontend.
   ========================================================================== */

const API_BASE = window.JOURNEYHACKER_API_BASE || "";
const PLAN_ENDPOINT = `${API_BASE}/api/plan`;
const THREAD_STORAGE_KEY = "journeyhacker_thread_id";

// ------------------------------------------------------------------------
// Elements
// ------------------------------------------------------------------------
const heroForm = document.getElementById("hero-form");
const heroQueryInput = document.getElementById("hero-query");
const plannerForm = document.getElementById("planner-form");
const plannerSubmit = document.getElementById("planner-submit");
const plannerError = document.getElementById("planner-error");
const freeformInput = document.getElementById("freeform");
const followupForm = document.getElementById("followup-form");
const followupInput = document.getElementById("followup-input");

const heroSection = document.getElementById("hero");
const howSection = document.getElementById("how-it-works");
const plannerSection = document.getElementById("planner");
const loadingState = document.getElementById("loading-state");
const resultsSection = document.getElementById("results");
const errorState = document.getElementById("error-state");
const errorMessageEl = document.getElementById("error-message");
const errorRetryBtn = document.getElementById("error-retry");
const newTripBtn = document.getElementById("new-trip-btn");

let lastQuery = "";
let activePrefs = new Set();
let loadingStepTimer = null;

// ------------------------------------------------------------------------
// Preference chips
// ------------------------------------------------------------------------
document.querySelectorAll(".chip.pref").forEach((btn) => {
  btn.addEventListener("click", () => {
    const pref = btn.dataset.pref;
    if (activePrefs.has(pref)) {
      activePrefs.delete(pref);
      btn.classList.remove("active");
    } else {
      activePrefs.add(pref);
      btn.classList.add("active");
    }
  });
});

document.querySelectorAll(".example-chips .chip:not(.pref)").forEach((btn) => {
  btn.addEventListener("click", () => {
    heroQueryInput.value = btn.dataset.example;
    heroQueryInput.focus();
  });
});

// ------------------------------------------------------------------------
// Build a natural-language query from the structured planner fields.
// The backend only accepts free text, so every field folds into one string.
// ------------------------------------------------------------------------
function buildQueryFromPlanner() {
  const origin = document.getElementById("origin").value.trim();
  const destination = document.getElementById("destination").value.trim();
  const departDate = document.getElementById("depart-date").value;
  const duration = document.getElementById("duration").value.trim();
  const travelers = document.getElementById("travelers").value.trim();
  const budget = document.getElementById("budget").value.trim();
  const currency = document.getElementById("currency").value;
  const freeform = freeformInput.value.trim();

  // Keep every detail in its own short sentence. flight_tool.py's parser
  // grabs everything between "from"/"to" and the next stop-word as the
  // location text — if we run all the details into one long phrase, a
  // trailing word like "for" or "with" can end up several words later
  // than intended, and the location text picked up the date/traveler
  // count along with it. A period right after the destination gives its
  // regex a clean, unambiguous place to stop.
  if (freeform) {
    const extras = [];
    if (travelers) extras.push(`Travelers: ${travelers}.`);
    if (activePrefs.size) extras.push(`Preferences: ${Array.from(activePrefs).join(", ")}.`);
    return extras.length ? `${freeform} ${extras.join(" ")}` : freeform;
  }

  const sentences = [];
  if (origin && destination) {
    sentences.push(`Plan a trip from ${origin} to ${destination}.`);
  } else if (destination) {
    sentences.push(`Plan a trip to ${destination}.`);
  } else if (origin) {
    sentences.push(`Plan a trip from ${origin}.`);
  } else {
    sentences.push("Plan a trip.");
  }

  if (duration) sentences.push(`Duration: ${duration} days.`);
  if (departDate) sentences.push(`Departure date: ${departDate}.`);
  if (travelers) sentences.push(`Travelers: ${travelers}.`);
  if (budget) sentences.push(`Budget: ${budget} ${currency}.`);
  if (activePrefs.size) sentences.push(`Preferences: ${Array.from(activePrefs).join(", ")}.`);

  return sentences.join(" ");
}

// ------------------------------------------------------------------------
// View switching
// ------------------------------------------------------------------------
function showView(view) {
  const sections = {
    landing: [heroSection, howSection, plannerSection],
    loading: [loadingState],
    results: [resultsSection],
    error: [errorState],
  };
  [heroSection, howSection, plannerSection, loadingState, resultsSection, errorState].forEach((el) => {
    el.hidden = true;
  });
  sections[view].forEach((el) => { el.hidden = false; });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ------------------------------------------------------------------------
// Loading step animation (cosmetic — mirrors the real agent order:
// flight_agent -> hotel_agent -> itinerary_agent -> final_agent)
// ------------------------------------------------------------------------
function startLoadingSteps() {
  const steps = Array.from(document.querySelectorAll("#loading-steps li"));
  steps.forEach((s) => s.classList.remove("active", "done"));
  let i = 0;
  if (steps.length) steps[0].classList.add("active");
  loadingStepTimer = setInterval(() => {
    if (i >= steps.length) return;
    steps[i].classList.remove("active");
    steps[i].classList.add("done");
    i += 1;
    if (i < steps.length) steps[i].classList.add("active");
  }, 2600);
}

function stopLoadingSteps() {
  clearInterval(loadingStepTimer);
}

// ------------------------------------------------------------------------
// Submit flow
// ------------------------------------------------------------------------
heroForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = heroQueryInput.value.trim();
  if (!q) { heroQueryInput.focus(); return; }
  freeformInput.value = q;
  submitTrip(q);
});

plannerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const query = buildQueryFromPlanner();
  if (!query || query === "Plan a trip") {
    plannerError.hidden = false;
    plannerError.textContent = "Add a destination or describe the trip you have in mind.";
    return;
  }
  plannerError.hidden = true;
  submitTrip(query);
});

async function submitTrip(query) {
  lastQuery = query;
  plannerSubmit.disabled = true;
  plannerSubmit.querySelector(".btn-spinner").hidden = false;
  showView("loading");
  startLoadingSteps();

  try {
    const stored = localStorage.getItem(THREAD_STORAGE_KEY);
    const payload = { query, thread_id: stored || null };

    const res = await fetch(PLAN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail || ""; } catch (_) {}
      throw new Error(detail || `The planning service returned an error (${res.status}).`);
    }

    const data = await res.json();
    if (!data || typeof data !== "object") {
      throw new Error("The planning service returned an unexpected response.");
    }

    if (data.thread_id) {
      localStorage.setItem(THREAD_STORAGE_KEY, data.thread_id);
    }

    renderResults(data);
    stopLoadingSteps();
    showView("results");
  } catch (err) {
    stopLoadingSteps();
    showError(err);
  } finally {
    plannerSubmit.disabled = false;
    plannerSubmit.querySelector(".btn-spinner").hidden = true;
  }
}

followupForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = followupInput.value.trim();
  if (!q) return;
  followupInput.value = "";
  submitTrip(q);
});

function showError(err) {
  console.error("JourneyHacker request failed:", err);
  errorMessageEl.textContent =
    err && err.message
      ? humanizeError(err.message)
      : "The request couldn't be completed. Check your connection and try again.";
  showView("error");
}

function humanizeError(message) {
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return "Couldn't reach the planning service. Make sure the backend is running and reachable.";
  }
  return message;
}

errorRetryBtn.addEventListener("click", () => {
  if (lastQuery) {
    submitTrip(lastQuery);
  } else {
    showView("landing");
  }
});

newTripBtn.addEventListener("click", () => {
  localStorage.removeItem(THREAD_STORAGE_KEY);
  heroQueryInput.value = "";
  freeformInput.value = "";
  plannerForm.reset();
  activePrefs.clear();
  document.querySelectorAll(".chip.pref.active").forEach((c) => c.classList.remove("active"));
  showView("landing");
});

// ==========================================================================
// Rendering — every parser below falls back to plain readable text if the
// expected shape isn't found. Nothing here invents data that wasn't in the
// backend response.
// ==========================================================================

function renderResults(data) {
  renderSummary(data);
  renderFlights(data.flight_results || "");
  renderHotels(data.hotel_results || "");
  renderItinerary(data.itinerary || "", data.answer || "");
  renderAnswerSections(data.answer || "");
  document.getElementById("raw-answer-body").textContent = data.answer || "No response text was returned.";
}

function renderSummary(data) {
  const strip = document.getElementById("summary-strip");
  strip.innerHTML = "";
  const pills = [];

  const destination = document.getElementById("destination").value.trim();
  const origin = document.getElementById("origin").value.trim();
  const duration = document.getElementById("duration").value.trim();
  const budget = document.getElementById("budget").value.trim();
  const currency = document.getElementById("currency").value;

  if (destination) pills.push(["Destination", destination]);
  if (origin) pills.push(["From", origin]);
  if (duration) pills.push(["Duration", `${duration} days`]);
  if (budget) pills.push(["Budget", `${budget} ${currency}`]);
  if (activePrefs.size) pills.push(["Style", Array.from(activePrefs).join(", ")]);
  if (!pills.length) pills.push(["Request", truncate(lastQuery, 70)]);

  pills.forEach(([label, value]) => {
    const pill = document.createElement("span");
    pill.className = "summary-pill";
    pill.innerHTML = `${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong>`;
    strip.appendChild(pill);
  });
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ---------------- Flights ----------------
   flight_tool.format_flight() always emits blocks in this exact shape,
   joined by "\n\n---\n\n":

   Airline: X
   Flight: Y
   Status: Z

   Departure:
   - Airport: ...
   - IATA: ...
   - Terminal: ...
   - Gate: ...
   - Scheduled: ...
   - Delay: ...

   Arrival: (same shape)

   Error / empty-result messages are plain sentences with no "Airline:" line,
   so we detect that and show them as a note instead of a broken card.
*/
function renderFlights(raw) {
  const el = document.getElementById("flights-body");
  el.innerHTML = "";

  const text = (raw || "").trim();
  if (!text) {
    el.innerHTML = `<p class="empty-note">No flight information was returned for this request.</p>`;
    return;
  }

  const blocks = text.split(/\n\n---\n\n/).filter((b) => /^Airline:/m.test(b));

  if (!blocks.length) {
    // Error message, "no flights found" note, or missing API key — show as-is.
    el.innerHTML = `<div class="parsed-text"><p>${escapeHtml(text).replace(/\n/g, "<br>")}</p></div>`;
    return;
  }

  blocks.forEach((block) => {
    const card = document.createElement("div");
    card.className = "flight-card fade-in";

    const get = (label) => {
      const m = block.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : "";
    };
    const getSection = (heading, label) => {
      const re = new RegExp(`${heading}:[\\s\\S]*?- ${label}:\\s*(.+)`, "m");
      const m = block.match(re);
      return m ? m[1].trim() : "";
    };

    const airline = get("Airline") || "Unknown airline";
    const flightNo = get("Flight") || "—";
    const status = (get("Status") || "unknown").toLowerCase();

    const depIata = getSection("Departure", "IATA");
    const arrIata = getSection("Arrival", "IATA");
    const depScheduled = getSection("Departure", "Scheduled");
    const arrScheduled = getSection("Arrival", "Scheduled");
    const depTerminal = getSection("Departure", "Terminal");
    const depGate = getSection("Departure", "Gate");
    const arrTerminal = getSection("Arrival", "Terminal");
    const arrGate = getSection("Arrival", "Gate");
    const depDelay = getSection("Departure", "Delay");
    const arrDelay = getSection("Arrival", "Delay");

    card.innerHTML = `
      <div class="flight-card-top">
        <span class="flight-airline">${escapeHtml(airline)} · ${escapeHtml(flightNo)}</span>
        <span class="flight-status ${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>
      <div class="flight-route">
        <span>${escapeHtml(depIata || "—")}</span>
        <span class="r-arrow">→</span>
        <span>${escapeHtml(arrIata || "—")}</span>
      </div>
      <div class="flight-meta">
        <div><span>Departs</span><span class="fm-value">${escapeHtml(depScheduled || "Unknown")}</span></div>
        <div><span>Arrives</span><span class="fm-value">${escapeHtml(arrScheduled || "Unknown")}</span></div>
        <div><span>Terminal / Gate (dep)</span><span class="fm-value">${escapeHtml(depTerminal || "N/A")} / ${escapeHtml(depGate || "N/A")}</span></div>
        <div><span>Terminal / Gate (arr)</span><span class="fm-value">${escapeHtml(arrTerminal || "N/A")} / ${escapeHtml(arrGate || "N/A")}</span></div>
        <div><span>Delay (dep)</span><span class="fm-value">${escapeHtml(depDelay || "N/A")}</span></div>
        <div><span>Delay (arr)</span><span class="fm-value">${escapeHtml(arrDelay || "N/A")}</span></div>
      </div>
      <p class="price-note">Ticket pricing unavailable from the current live flight API.</p>
    `;
    el.appendChild(card);
  });
}

/* ---------------- Hotels ----------------
   tavily_tool.tavily_search() emits entries separated by "\n\n":
   "1, **Title**\n url \n snippet"
   (note the comma after the index — that's the tool's actual formatting)
*/
function renderHotels(raw) {
  const el = document.getElementById("hotels-body");
  el.innerHTML = "";

  const text = (raw || "").trim();
  if (!text) {
    el.innerHTML = `<p class="empty-note">No hotel information was returned for this request.</p>`;
    return;
  }

  const entries = text.split(/\n\n+/).filter((e) => /\*\*(.+?)\*\*/.test(e));

  if (!entries.length) {
    el.innerHTML = `<div class="parsed-text"><p>${escapeHtml(text).replace(/\n/g, "<br>")}</p></div>`;
    return;
  }

  entries.forEach((entry) => {
    const lines = entry.split("\n").map((l) => l.trim()).filter(Boolean);
    const titleMatch = entry.match(/\*\*(.+?)\*\*/);
    const title = titleMatch ? titleMatch[1] : "Untitled result";
    const urlLine = lines.find((l) => /^https?:\/\//.test(l));
    const snippetLine = lines.filter((l) => l !== lines[0] && l !== urlLine).join(" ");

    const card = document.createElement("div");
    card.className = "hotel-card fade-in";
    card.innerHTML = `
      <p class="hotel-title">${urlLine ? `<a href="${escapeHtml(urlLine)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>` : escapeHtml(title)}</p>
      <p class="hotel-snippet">${escapeHtml(snippetLine || "No description returned.")}</p>
    `;
    el.appendChild(card);
  });
}

/* ---------------- Itinerary ----------------
   The itinerary_agent prompt doesn't pin down a format, so the LLM is just
   as likely to reply with a markdown table ("| Day | Morning | ... |") as
   with plain "Day 1: ..." prose. We only build the visual day-by-day
   timeline when the source is genuinely line-based prose; if it contains
   markdown table syntax anywhere, slicing it by "Day N" would cut rows in
   half, so we render the whole thing through the markdown renderer instead
   — same content, still readable, tables intact.
*/
function renderItinerary(itineraryText, answerText) {
  const el = document.getElementById("itinerary-body");
  el.innerHTML = "";

  let source = (itineraryText || "").trim();
  if (!source) {
    source = extractSectionByKeyword(answerText, ["day-by-day", "itinerary"]);
  }

  if (!source) {
    el.innerHTML = `<p class="empty-note">No itinerary was returned for this request.</p>`;
    return;
  }

  const hasTable = /^\s*\|/m.test(source);

  if (hasTable) {
    el.innerHTML = `<div class="parsed-text markdown-doc">${renderMarkdown(source)}</div>`;
    return;
  }

  const dayRegex = /(?:^|\n)\s*(?:\*\*)?Day\s+(\d+)[:\-\.]?\s*(.*?)(?:\*\*)?\s*(?:\n|$)/gi;
  const matches = [...source.matchAll(dayRegex)];

  if (!matches.length) {
    el.innerHTML = `<div class="parsed-text markdown-doc">${renderMarkdown(source)}</div>`;
    return;
  }

  const timeline = document.createElement("div");
  timeline.className = "timeline";

  matches.forEach((m, idx) => {
    const dayNum = m[1];
    const title = m[2] ? m[2].trim() : "";
    const start = m.index + m[0].length;
    const end = idx + 1 < matches.length ? matches[idx + 1].index : source.length;
    const body = source.slice(start, end).trim();

    const item = document.createElement("div");
    item.className = "timeline-day fade-in";
    item.innerHTML = `
      <h4>Day ${escapeHtml(dayNum)}${title ? " — " + escapeHtml(title) : ""}</h4>
      <div class="day-body markdown-doc">${renderMarkdown(body)}</div>
    `;
    timeline.appendChild(item);
  });

  el.appendChild(timeline);
}

/* ---------------- Budget & Recommendations ----------------
   Neither agent prompt guarantees exact heading wording (we've seen
   "Estimated Budget", "Quick-Reference Budget", "Budget Breakdown" all
   from the same backend across different runs), so we match headings by
   keyword rather than exact phrase, then render whatever markdown is
   under it — tables included.
*/
function renderAnswerSections(answerText) {
  const budgetEl = document.getElementById("budget-body");
  const recEl = document.getElementById("recommendations-body");

  const budget = extractSectionByKeyword(answerText, ["budget", "cost"]);
  const recs = extractSectionByKeyword(answerText, ["recommend", "final tips", "tips"]);

  budgetEl.innerHTML = budget
    ? `<div class="parsed-text markdown-doc">${renderMarkdown(budget)}</div>`
    : `<p class="empty-note">No structured budget breakdown was returned — see the full response below.</p>`;

  recEl.innerHTML = recs
    ? `<div class="parsed-text markdown-doc">${renderMarkdown(recs)}</div>`
    : `<p class="empty-note">No recommendations section was found — see the full response below.</p>`;
}

// A "heading" line in this LLM's output can be "### Text", "**Text**" alone
// on its line, or "N. Text" — so we detect any of those shapes, then grab
// everything until the next heading line whose text contains one of the
// given keywords (case-insensitive substring match, since exact wording
// isn't guaranteed run to run).
function isHeadingLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^#{1,4}\s+\S/.test(t)) return true;
  if (/^\*\*[^*].*[^*]\*\*$/.test(t)) return true;
  if (/^\d+\.\s*\*{0,2}[A-Za-z]/.test(t)) return true;
  return false;
}

function headingText(line) {
  return line.trim().replace(/^#{1,4}\s+/, "").replace(/\*\*/g, "").replace(/^\d+\.\s*/, "");
}

function extractSectionByKeyword(text, keywords) {
  if (!text) return "";
  const lines = text.split("\n");
  const headingIdx = [];
  lines.forEach((line, i) => { if (isHeadingLine(line)) headingIdx.push(i); });

  for (let h = 0; h < headingIdx.length; h++) {
    const idx = headingIdx[h];
    const title = headingText(lines[idx]).toLowerCase();
    if (keywords.some((k) => title.includes(k))) {
      const start = idx + 1;
      const end = h + 1 < headingIdx.length ? headingIdx[h + 1] : lines.length;
      const body = lines.slice(start, end).join("\n").trim();
      if (body) return body;
    }
  }
  return "";
}

/* ---------------- Markdown rendering ----------------
   Small, dependency-free renderer for the subset of markdown this backend
   actually produces: #/##/### headings, **bold**, > blockquotes, --- rules,
   - bullet lists, and | pipe | tables |. Everything is HTML-escaped first,
   so this never trusts raw HTML from the LLM — the one deliberate exception
   is turning a literal "<br>" the LLM wrote as text back into a line break,
   which is a plain string swap, not markup we parse or evaluate.
*/
function renderMarkdown(text) {
  const normalized = escapeHtml(text).replace(/&lt;br\s*\/?&gt;/gi, "\n");
  const lines = normalized.split("\n");

  let html = "";
  let i = 0;
  let inList = false;

  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) { closeList(); i++; continue; }

    // Table block: a header row, an optional separator row, then body rows.
    if (/^\|/.test(line)) {
      closeList();
      const tableLines = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        tableLines.push(lines[i].trim());
        i++;
      }
      html += renderTable(tableLines);
      continue;
    }

    if (/^-{3,}$/.test(line)) { closeList(); html += "<hr>"; i++; continue; }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = Math.min(headingMatch[1].length + 3, 6); // h4..h6
      html += `<h${level}>${boldify(headingMatch[2])}</h${level}>`;
      i++; continue;
    }

    if (/^&gt;\s?/.test(line)) {
      closeList();
      const quoteLines = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^&gt;\s?/, ""));
        i++;
      }
      html += `<blockquote>${boldify(quoteLines.join(" "))}</blockquote>`;
      continue;
    }

    if (/^[-*•]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${boldify(line.replace(/^[-*•]\s+/, ""))}</li>`;
      i++; continue;
    }

    closeList();
    html += `<p>${boldify(line)}</p>`;
    i++;
  }
  closeList();
  return html || `<p>${normalized}</p>`;
}

function renderTable(tableLines) {
  const rows = tableLines
    .map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c))); // drop the |---|---| separator row

  if (!rows.length) return "";

  const [headerRow, ...bodyRows] = rows;
  let html = "<table class='md-table'><thead><tr>";
  headerRow.forEach((cell) => { html += `<th>${boldify(cell)}</th>`; });
  html += "</tr></thead><tbody>";
  bodyRows.forEach((cells) => {
    html += "<tr>";
    cells.forEach((cell) => { html += `<td>${boldify(cell)}</td>`; });
    html += "</tr>";
  });
  html += "</tbody></table>";
  return html;
}

function boldify(str) {
  return str.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
