import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  query,
  orderBy,
  getDocs,
  serverTimestamp,
  limit,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBhqTcXe3HmkzyzesFcAOaYbBcUfrnmavk",
  authDomain: "athena-d0fe8.firebaseapp.com",
  projectId: "athena-d0fe8",
  storageBucket: "athena-d0fe8.firebasestorage.app",
  messagingSenderId: "721703140811",
  appId: "1:721703140811:web:cb505d39948c300bda8a4e",
  measurementId: "G-NXTL8MTJZ",
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

const GROQ_API_KEY = "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";
const YT_API_KEY = "AIzaSyDU8kLLkhMZONkwDOBbj3r9_mWIfLE4eXM";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
/** Default + vision paths (Llama 4 Scout on Groq). */
const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_MODEL_VISION = "meta-llama/llama-4-scout-17b-16e-instruct";

const MAX_FILE_TEXT_CHARS = 12000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** @type {{ dataUrl: string } | null} */
let pendingImage = null;
/** @type {{ name: string, text: string } | null} */
let pendingFile = null;

let currentMode = "beginner";
let historyStack = [""];
let historyIndex = 0;
let sidebarTopics = [];
const chatHistory = [];

const difficultyLabel = {
  child: "Child",
  beginner: "Beginner",
  adult: "Expert",
};
const toneLabel = {
  child: "Playful and simple",
  beginner: "Clear and textbook-friendly",
  adult: "Rigorous and technical",
};

/** Prompt block + jargon count range per difficulty (controls length & depth of generation). */
const difficultyOutputGuide = {
  child: `
DIFFICULTY — CHILD (follow strictly):
- Explain as if to a curious child (~8–10): warm, playful, very short sentences.
- Use only simple everyday words; if you must use a technical word, explain it in the same breath.
- LENGTH: SHORT — about 4–7 bullet lines total; each bullet is at most 1–2 short sentences. Whole explanation roughly 80–160 words. Do not write long paragraphs.
- Favor one concrete analogy (toys, animals, food, games) over abstract theory.
- buildingBlocks: three very simple 2–4 word labels a child could tap next.`,
  beginner: `
DIFFICULTY — BEGINNER (follow strictly):
- Clear, friendly “good textbook intro” level: accurate but approachable (high school / early college).
- LENGTH: MEDIUM — about 8–14 bullet lines (or equivalent structure); roughly 220–420 words.
- Introduce terms carefully; one idea per bullet where possible.
- buildingBlocks: three short phrases (concepts to explore next).`,
  adult: `
DIFFICULTY — EXPERT (follow strictly):
- Rigorous and technical: precise terms, mechanisms, trade-offs, limitations, and nuance; assume an educated reader in the user’s field.
- LENGTH: LONG — about 14–28 bullet lines or equivalent; roughly 450–950+ words when the topic needs depth (do not artificially pad).
- Use domain-appropriate vocabulary; it is OK to be dense when clarity allows.
- buildingBlocks: three precise technical or named concepts worth deeper study.`,
};

const jargonTermsCountByMode = {
  child: "3 to 4",
  beginner: "4 to 6",
  adult: "5 to 7",
};

const temperatureByMode = {
  child: 0.38,
  beginner: 0.45,
  adult: 0.52,
};

function escapeHTML(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Model returns { term, simplified } — terms must appear in the explanation text. */
function normalizeJargonTerms(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((j) => {
      if (!j || typeof j !== "object") return null;
      const term = j.term ?? j.Term;
      const simplified = j.simplified ?? j.definition ?? j.simple;
      if (!term || !simplified) return null;
      const t = String(term).trim();
      const s = String(simplified).trim();
      if (!t || !s) return null;
      return { term: t, simplified: s.slice(0, 400) };
    })
    .filter(Boolean)
    .sort((a, b) => b.term.length - a.term.length);
}

/**
 * Wraps glossary terms in .jargon spans (hover / focus shows data-tooltip).
 * Skips text already inside .jargon.
 */
function applyJargonTooltips(html, jargonTerms) {
  if (!jargonTerms.length) return html;
  const div = document.createElement("div");
  div.innerHTML = html;

  for (const { term, simplified } of jargonTerms) {
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest(".jargon")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const batch = [];
    let n;
    while ((n = walker.nextNode())) batch.push(n);

    for (const textNode of batch) {
      if (!textNode.parentNode) continue;
      const text = textNode.textContent;
      const re = new RegExp(`(\\b${escapeRegExp(term)}\\b)`, "gi");
      const parts = text.split(re);
      if (parts.length < 2) continue;
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (part === "") continue;
        const isMatch = part.toLowerCase() === term.toLowerCase();
        if (isMatch) {
          const span = document.createElement("span");
          span.className = "jargon";
          span.setAttribute("data-tooltip", simplified);
          span.setAttribute("title", simplified);
          span.setAttribute("tabindex", "0");
          span.setAttribute(
            "aria-label",
            `Simplified meaning: ${simplified.slice(0, 200)}`,
          );
          span.textContent = part;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  return div.innerHTML;
}

window.addEventListener("load", () => {
  setTimeout(() => {
    const splash = document.getElementById("splash-screen");
    splash.style.opacity = "0";
    document.getElementById("main-wrapper").style.opacity = "1";
    setTimeout(() => {
      splash.style.visibility = "hidden";
    }, 800);
  }, 2000);
  setMode("beginner", 1);
});

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("sidebarOverlay").classList.toggle("visible");
}

function toggleAttachmentMenu(event) {
  event.stopPropagation();
  document.getElementById("attachmentMenu").classList.toggle("hidden");
}

window.addEventListener("click", () => {
  const menu = document.getElementById("attachmentMenu");
  if (menu) menu.classList.add("hidden");
});

function triggerImagePick(e) {
  e.stopPropagation();
  document.getElementById("attachmentMenu")?.classList.add("hidden");
  document.getElementById("hiddenImageInput")?.click();
}

function triggerFilePick(e) {
  e.stopPropagation();
  document.getElementById("attachmentMenu")?.classList.add("hidden");
  document.getElementById("hiddenFileInput")?.click();
}

function clearPendingAttachments() {
  pendingImage = null;
  pendingFile = null;
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  const el = document.getElementById("attachmentPreview");
  if (!el) return;
  el.innerHTML = "";
  if (!pendingImage && !pendingFile) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const row = document.createElement("div");
  row.className = "flex items-center gap-3 flex-wrap";
  if (pendingImage?.dataUrl) {
    const img = document.createElement("img");
    img.src = pendingImage.dataUrl;
    img.alt = "Preview";
    img.className =
      "h-16 w-auto max-w-[120px] rounded-lg border border-gray-200 dark:border-slate-600 object-cover";
    row.appendChild(img);
  }
  if (pendingFile) {
    const lab = document.createElement("span");
    lab.className =
      "text-xs text-gray-600 dark:text-gray-400 max-w-[220px] truncate";
    lab.textContent = `${pendingFile.name} · ${pendingFile.text.length.toLocaleString()} chars`;
    row.appendChild(lab);
  }
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.setAttribute("aria-label", "Remove attachment");
  clearBtn.className =
    "ml-auto text-lg leading-none text-gray-400 hover:text-red-500 px-2";
  clearBtn.textContent = "×";
  clearBtn.onclick = () => clearPendingAttachments();
  row.appendChild(clearBtn);
  el.appendChild(row);
}

function onHiddenImageChange(e) {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f || !f.type.startsWith("image/")) return;
  if (f.size > MAX_IMAGE_BYTES) {
    alert("Image is too large. Maximum size is 4 MB.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = { dataUrl: reader.result };
    renderAttachmentPreview();
  };
  reader.readAsDataURL(f);
}

async function extractTextFromFile(file) {
  const name = file.name || "";
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  const buf = await file.arrayBuffer();

  if (ext === "txt" || file.type === "text/plain") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return text.slice(0, MAX_FILE_TEXT_CHARS);
  }

  if (ext === "pdf" || file.type === "application/pdf") {
    if (typeof pdfjsLib === "undefined") {
      throw new Error("PDF.js failed to load. Refresh the page.");
    }
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = "";
    const maxPages = Math.min(pdf.numPages, 40);
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const line = content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ");
      out += line + "\n";
    }
    return out.trim().slice(0, MAX_FILE_TEXT_CHARS);
  }

  if (
    ext === "docx" ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    if (typeof mammoth === "undefined") {
      throw new Error("Mammoth failed to load. Refresh the page.");
    }
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return (result.value || "").trim().slice(0, MAX_FILE_TEXT_CHARS);
  }

  throw new Error("Unsupported type. Use .pdf, .txt, or .docx.");
}

async function onHiddenFileChange(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  document.getElementById("attachmentMenu")?.classList.add("hidden");
  const prev = document.getElementById("attachmentPreview");
  if (prev) {
    prev.classList.remove("hidden");
    prev.innerHTML =
      '<span class="text-sm text-indigo-500 dark:text-indigo-400">Extracting text…</span>';
  }
  try {
    const text = await extractTextFromFile(file);
    if (!text.trim()) {
      throw new Error("No readable text found in this file.");
    }
    pendingFile = { name: file.name, text };
    pendingImage = null;
    renderAttachmentPreview();
  } catch (err) {
    alert(err.message || "Could not read file.");
    pendingFile = null;
    renderAttachmentPreview();
  }
}

function setExplainButtonProcessing(isBusy) {
  const btn = document.getElementById("simplifyBtn");
  if (!btn) return;
  btn.disabled = isBusy;
  btn.classList.toggle("opacity-60", isBusy);
  btn.classList.toggle("cursor-wait", isBusy);
  btn.setAttribute("aria-busy", isBusy ? "true" : "false");
}

function updateSidebarHistory(topic) {
  if (auth.currentUser) return;
  if (!sidebarTopics.includes(topic)) {
    sidebarTopics.unshift(topic);
    renderSidebar();
  }
}

function renderSidebar() {
  if (auth.currentUser) return;
  const list = document.getElementById("historyList");
  if (!list) return;
  if (sidebarTopics.length === 0) {
    list.innerHTML =
      '<li class="text-xs text-gray-400 italic px-4 list-none">No recent searches...</li>';
    return;
  }
  list.innerHTML = sidebarTopics
    .map(
      (topic) =>
        `<li class="history-item" role="button" tabindex="0">${escapeHTML(topic)}</li>`,
    )
    .join("");
  list.querySelectorAll(".history-item").forEach((el, i) => {
    const topic = sidebarTopics[i];
    const go = () => loadHistoryItem(topic);
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
  });
}

function loadHistoryItem(topic) {
  document.getElementById("conceptInput").value = topic;
  generateResponse();
  if (window.innerWidth < 1024) toggleSidebar();
}

function applyAuthVisibility(signedIn) {
  const overlay = document.getElementById("authOverlay");
  const appRoot = document.getElementById("appRoot");
  if (!overlay || !appRoot) return;
  if (signedIn) {
    overlay.classList.add("auth-hidden");
    appRoot.classList.add("app-visible");
  } else {
    overlay.classList.remove("auth-hidden");
    appRoot.classList.remove("app-visible");
  }
}

function updateUserProfileUI(user) {
  const wrap = document.getElementById("userProfile");
  const nameEl = document.getElementById("userProfileName");
  const sidebarName = document.getElementById("sidebarProfileName");
  const modalName = document.getElementById("profileModalDisplayName");
  const modalEmail = document.getElementById("profileModalEmail");
  const avatar = document.getElementById("profileAvatarLetter");
  if (!user) {
    wrap?.classList.remove("visible");
    if (sidebarName) sidebarName.textContent = "—";
    return;
  }
  const dn = user.displayName || user.email || "User";
  if (nameEl) nameEl.textContent = dn;
  if (sidebarName) sidebarName.textContent = dn;
  if (modalName) modalName.textContent = dn;
  if (modalEmail) modalEmail.textContent = user.email || "Signed in with Google";
  if (avatar) avatar.textContent = String(dn).charAt(0).toUpperCase();
  wrap?.classList.add("visible");
}

async function signInWithGoogle() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    console.error(e);
    if (e?.code === "auth/unauthorized-domain") {
      alert(
        'Firebase: this site is not an authorized domain.\n\n' +
          "Quick fix: open the app at http://localhost:PORT (not 127.0.0.1).\n\n" +
          "Or in Firebase Console → Authentication → Settings → Authorized domains, add: 127.0.0.1",
      );
      return;
    }
    const msg =
      e?.code === "auth/popup-closed-by-user"
        ? "Sign-in was cancelled."
        : e?.message || "Sign-in failed.";
    alert(msg);
  }
}

async function signOutApp() {
  try {
    await signOut(auth);
  } catch (e) {
    console.error(e);
  }
}

/**
 * @param {string} userPrompt
 * @param {object} aiResponseJSON
 * @param {string} difficultyLevel
 * @param {string} [promptLabel]
 */
async function saveChatToDatabase(
  userPrompt,
  aiResponseJSON,
  difficultyLevel,
  promptLabel,
) {
  const user = auth.currentUser;
  if (!user) return;
  try {
    await addDoc(collection(db, "users", user.uid, "chats"), {
      userPrompt,
      promptLabel: promptLabel || userPrompt,
      aiResponseJSON,
      difficultyLevel,
      createdAt: serverTimestamp(),
    });
    await loadUserHistory(user.uid);
  } catch (e) {
    console.error("saveChatToDatabase", e);
  }
}

async function loadUserHistory(uid) {
  const list = document.getElementById("historyList");
  if (!list) return;
  list.innerHTML =
    '<li class="text-xs text-gray-400 italic px-4 list-none">Loading…</li>';
  try {
    const q = query(
      collection(db, "users", uid, "chats"),
      orderBy("createdAt", "desc"),
      limit(40),
    );
    const snap = await getDocs(q);
    if (snap.empty) {
      list.innerHTML =
        '<li class="text-xs text-gray-400 italic px-4 list-none">No saved chats yet.</li>';
      return;
    }
    list.innerHTML = "";
    snap.forEach((d) => {
      const data = d.data();
      const raw = String(data.promptLabel || data.userPrompt || "Chat");
      const snippet = raw.length > 72 ? `${raw.slice(0, 72)}…` : raw;
      const li = document.createElement("li");
      li.className = "history-item";
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", "0");
      li.dataset.chatId = d.id;
      li.textContent = snippet;
      const open = async () => {
        const ref = doc(db, "users", uid, "chats", d.id);
        const docSnap = await getDoc(ref);
        if (!docSnap.exists()) return;
        await restoreChatFromSaved(docSnap.data());
        if (window.innerWidth < 1024) toggleSidebar();
      };
      li.addEventListener("click", open);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
      list.appendChild(li);
    });
  } catch (e) {
    console.error("loadUserHistory", e);
    list.innerHTML = `<li class="text-xs text-red-500 px-4 list-none">${escapeHTML(e.message)}</li>`;
  }
}

/** @param {Record<string, unknown>} data */
async function restoreChatFromSaved(data) {
  const raw = data.aiResponseJSON;
  const llmJson =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const diff = data.difficultyLevel;
  if (diff === "child" || diff === "beginner" || diff === "adult") {
    const idx = { child: 0, beginner: 1, adult: 2 }[diff];
    setMode(diff, idx);
  }

  const template = document.getElementById("historyTemplate");
  const clone = template.content.cloneNode(true);
  const imgWrap = clone.querySelector(".prompt-image-wrap");
  imgWrap.classList.add("hidden");
  imgWrap.innerHTML = "";
  const label = String(data.promptLabel || data.userPrompt || "Saved chat");
  clone.querySelector(".prompt-text").textContent = label;

  const explanation = normalizeExplanation(
    llmJson.explanation || "No explanation stored.",
  );
  const buildingBlocks = Array.isArray(llmJson.buildingBlocks)
    ? llmJson.buildingBlocks.slice(0, 3)
    : [];
  const youtubeQuery = String(llmJson.youtubeSearchQuery || "");
  const jargonTerms = normalizeJargonTerms(llmJson.jargonTerms);

  const outputArea = clone.querySelector(".output-content");
  const prereqs = clone.querySelector(".prerequisite-container");
  const videoContainer = clone.querySelector(".video-container");

  outputArea.innerHTML = applyJargonTooltips(
    formatExplanationToHtml(explanation),
    jargonTerms,
  );
  prereqs.innerHTML = "";
  buildingBlocks.forEach((term) => {
    const capsule = document.createElement("button");
    capsule.type = "button";
    capsule.className = "capsule";
    capsule.textContent = term;
    capsule.onclick = () => {
      document.getElementById("conceptInput").value = term;
      generateResponse(document.getElementById("conceptInput"));
    };
    prereqs.appendChild(capsule);
  });

  const historyEl = document.getElementById("chatHistory");
  historyEl.innerHTML = "";
  historyEl.appendChild(clone);
  historyStack = [historyEl.innerHTML];
  historyIndex = 0;

  await fetchYouTubeVideo(youtubeQuery, videoContainer);
  window.scrollTo({ top: 420, behavior: "smooth" });
}

function openProfile() {
  document.getElementById("profileModal").classList.add("open");
  if (window.innerWidth < 1024) toggleSidebar();
}

function openSettings() {
  document.getElementById("settingsModal").classList.add("open");
  if (window.innerWidth < 1024) toggleSidebar();
}

function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

function setMode(mode, index) {
  currentMode = mode;
  const slider = document.getElementById("slider");
  slider.style.transform = `translateX(${index * 100}%)`;
  const darkOn = document.body.classList.contains("dark-mode");
  document.body.classList.remove(
    "theme-child",
    "theme-beginner",
    "theme-adult",
  );
  document.body.classList.add(`theme-${mode}`);
  if (darkOn) document.body.classList.add("dark-mode");
  document.querySelectorAll(".segment-btn").forEach((btn, i) => {
    btn.classList.toggle("active", i === index);
  });
}

function toggleDarkMode() {
  document.body.classList.toggle("dark-mode");
  document.documentElement.classList.toggle(
    "dark",
    document.body.classList.contains("dark-mode"),
  );
}

function handleEnter(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    generateResponse(e.target);
  }
}

function newChat() {
  document.getElementById("chatHistory").innerHTML = "";
  document.getElementById("conceptInput").value = "";
  document.getElementById("majorInput").value = "";
  chatHistory.length = 0;
  saveHistoryState();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function copyToClipboard(btn) {
  const card = btn.closest(".chat-item");
  const videoContainer = card.querySelector(".video-container");
  const watchLink = card.querySelector(".yt-watch-link");
  const explanation =
    card.querySelector(".output-content")?.innerText?.trim() ?? "";

  let textToCopy = "";
  const fromData = videoContainer?.dataset?.youtubeUrl?.trim() ?? "";
  if (fromData.startsWith("http")) {
    textToCopy = fromData;
  } else {
    const href = watchLink?.getAttribute("href") || watchLink?.href || "";
    if (
      href.startsWith("http") &&
      (href.includes("youtube.com") || href.includes("youtu.be"))
    ) {
      textToCopy = href;
    }
  }
  if (!textToCopy) {
    textToCopy = explanation;
  }

  const copiedVideo = Boolean(
    textToCopy.startsWith("http") &&
    (textToCopy.includes("youtube.com") || textToCopy.includes("youtu.be")),
  );

  const done = () => {
    const original = btn.innerText;
    btn.innerText = copiedVideo ? "VIDEO LINK COPIED!" : "COPIED!";
    btn.classList.add("text-indigo-500");
    setTimeout(() => {
      btn.innerText = original;
      btn.classList.remove("text-indigo-500");
    }, 1800);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(textToCopy).then(done).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
  function fallbackCopy() {
    const el = document.createElement("textarea");
    el.value = textToCopy;
    document.body.appendChild(el);
    el.select();
    try {
      document.execCommand("copy");
      done();
    } finally {
      document.body.removeChild(el);
    }
  }
}

function saveHistoryState() {
  const html = document.getElementById("chatHistory").innerHTML;
  if (html === historyStack[historyIndex]) return;
  historyStack = historyStack.slice(0, historyIndex + 1);
  historyStack.push(html);
  historyIndex++;
}

function undo() {
  if (historyIndex > 0) {
    historyIndex--;
    document.getElementById("chatHistory").innerHTML =
      historyStack[historyIndex];
  }
}

function redo() {
  if (historyIndex < historyStack.length - 1) {
    historyIndex++;
    document.getElementById("chatHistory").innerHTML =
      historyStack[historyIndex];
  }
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    if (e.shiftKey) redo();
    else undo();
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "y") {
    redo();
    e.preventDefault();
  }
});

function normalizeExplanation(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");
  if (value && typeof value === "object")
    return Object.values(value)
      .map((v) => String(v))
      .join("\n");
  return String(value ?? "");
}

function extractJsonFromText(rawText) {
  const trimmed = String(rawText || "").trim();
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  };
  let parsed = tryParse(trimmed);
  if (parsed) return parsed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    parsed = tryParse(fenceMatch[1].trim());
    if (parsed) return parsed;
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    parsed = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }
  throw new Error("No valid JSON found in model response.");
}

function formatExplanationToHtml(explanation) {
  const lines = normalizeExplanation(explanation)
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!lines.length) return "<p>No explanation returned.</p>";
  if (lines.every((line) => /^[-*•]/.test(line))) {
    return `<ul class="list-disc pl-8 space-y-3 font-normal">${lines
      .map((line) => `<li>${escapeHTML(line.replace(/^[-*•]\s*/, ""))}</li>`)
      .join("")}</ul>`;
  }
  return lines.map((line) => `<p>${escapeHTML(line)}</p>`).join("");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetrySecondsFromMessage(msg) {
  const m = String(msg || "").match(/retry in ([\d.]+)\s*s/i);
  if (m) return Math.min(15, parseFloat(m[1], 10) + 0.35);
  return null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(
        `Request timed out after ${timeoutMs / 1000}s. Check your connection or try again.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function buildUserPromptForApi(
  concept,
  major,
  fileText,
  fileName,
  hasImage,
) {
  const c = (concept || "").trim();
  let q = c;
  if (!q && hasImage) {
    q =
      "Describe the attached image and explain the main ideas in a way that matches the selected difficulty.";
  }
  if (!q && fileText && !hasImage) {
    q =
      "Summarize and explain the key ideas from the uploaded document for the selected difficulty.";
  }
  if (!q) q = "(No question text — use attachments only.)";

  let block = `
User Question: ${q}
Difficulty: ${difficultyLabel[currentMode]}
User Major/Profession: ${major || "General"}
`.trim();
  if (fileText && fileName) {
    block += `\n\n--- Extracted text from "${fileName}" ---\n${fileText}`;
  }
  return block;
}

/**
 * @param {string} concept
 * @param {string} major
 * @param {{ imageDataUrl?: string | null, fileText?: string | null, fileName?: string | null }} [attachment]
 */
async function fetchLLMResponse(concept, major, attachment = {}) {
  const imageDataUrl = attachment.imageDataUrl || null;
  const fileText = attachment.fileText || null;
  const fileName = attachment.fileName || null;
  const hasImage = Boolean(imageDataUrl);
  const model = hasImage ? GROQ_MODEL_VISION : GROQ_MODEL;

  const jargonCount = jargonTermsCountByMode[currentMode] || "4 to 6";
  const systemPrompt = `
You are Athena, an educational explainer.
Return a single JSON object only (no markdown fences, no text before or after).

${difficultyOutputGuide[currentMode]}

Required shape — use these exact keys as double-quoted JSON keys:
"explanation": string (one JSON string value)
"buildingBlocks": array of exactly 3 strings
"youtubeSearchQuery": string
"jargonTerms": array of ${jargonCount} objects, each exactly: { "term": string, "simplified": string }

CRITICAL JSON rules:
- Every string value must start and end with double-quote characters. Never write patterns like "explanation": * item or use bare asterisk bullets as values.
- Put bullet lines INSIDE the "explanation" string: use newline between lines; each line may start with "- " (hyphen space). Do not use * at line starts inside JSON.
- buildingBlocks must be a JSON array like ["a","b","c"], not bullets.

Jargon Buster (required):
- Pick words that appear verbatim in "explanation"; count must match the array size rule above for this difficulty.
- For each, "term" must match how it appears in the explanation (same spelling).
- "simplified": for Child, one very short child-friendly phrase; for Beginner, one clear sentence; for Expert, may be one precise sentence.

Content rules:
1) Voice and tone must match "${difficultyLabel[currentMode]}" (${toneLabel[currentMode]}).
2) Tailor examples to major/profession: "${major || "General"}".
3) Last line of explanation must be a "- Real-Life Application:" bullet.
${hasImage ? "\n4) The user attached an image — ground your explanation in what is shown when relevant." : ""}
${fileText ? "\n5) Use the extracted document text when it helps answer the question." : ""}
`.trim();

  const userPromptText = buildUserPromptForApi(
    concept,
    major,
    fileText,
    fileName,
    hasImage,
  );

  const trimmedHistory = chatHistory.slice(-24);
  const historyMessages = trimmedHistory.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const lastUser = hasImage
    ? {
        role: "user",
        content: [
          { type: "text", text: userPromptText },
          {
            type: "image_url",
            image_url: { url: imageDataUrl },
          },
        ],
      }
    : { role: "user", content: userPromptText };

  const groqMessages = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    lastUser,
  ];

  const basePayload = {
    model,
    messages: groqMessages,
    temperature: temperatureByMode[currentMode] ?? 0.45,
  };
  let useJsonObjectMode = true;

  const maxAttempts = 3;
  const groqTimeoutMs = 90000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const payload = useJsonObjectMode
      ? { ...basePayload, response_format: { type: "json_object" } }
      : basePayload;
    const response = await fetchWithTimeout(
      GROQ_CHAT_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify(payload),
      },
      groqTimeoutMs,
    );

    if (response.ok) {
      const data = await response.json();
      const rawText = data?.choices?.[0]?.message?.content || "";
      try {
        return extractJsonFromText(rawText);
      } catch (parseErr) {
        throw new Error(
          `Invalid JSON from model: ${parseErr.message}. Try again; the reply must be one JSON object.`,
        );
      }
    }

    let detail = "";
    try {
      const errBody = await response.json();
      detail =
        errBody?.error?.message || JSON.stringify(errBody?.error || errBody);
    } catch (_) {}

    if (
      response.status === 400 &&
      useJsonObjectMode &&
      /response_format|json_object|json mode|does not support|invalid.?value/i.test(
        String(detail),
      )
    ) {
      useJsonObjectMode = false;
      attempt--;
      continue;
    }

    const isRateLimited = response.status === 429;
    const canRetry = isRateLimited && attempt < maxAttempts - 1;

    if (canRetry) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const headerSec = retryAfterHeader
        ? parseFloat(retryAfterHeader, 10)
        : NaN;
      const waitSec = Math.min(
        20,
        (Number.isFinite(headerSec) ? headerSec : null) ??
          parseRetrySecondsFromMessage(detail) ??
          Math.min(12, 2 + attempt * 3),
      );
      await sleep(waitSec * 1000);
      continue;
    }

    const quotaHint = /quota|rate|limit|billing/i.test(detail)
      ? " See https://console.groq.com for usage and limits."
      : "";
    throw new Error(
      detail
        ? `Groq (${model}) error ${response.status}: ${detail}.${quotaHint}`
        : `Groq (${model}) error: ${response.status}`,
    );
  }
  throw new Error(
    `Groq (${model}): request failed after ${maxAttempts} attempts.`,
  );
}

let youtubeIframeApiPromise = null;
function loadYouTubeIframeAPI() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (!youtubeIframeApiPromise) {
    youtubeIframeApiPromise = new Promise((resolve) => {
      const prior = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prior === "function") prior();
        resolve();
      };
      if (!document.querySelector('script[src*="iframe_api"]')) {
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(s);
      }
    });
  }
  return youtubeIframeApiPromise;
}

async function fetchYouTubeVideo(searchQuery, videoContainer) {
  if (!searchQuery) return;
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/search");
  endpoint.searchParams.set("part", "snippet");
  endpoint.searchParams.set("q", searchQuery);
  endpoint.searchParams.set("maxResults", "12");
  endpoint.searchParams.set("type", "video");
  endpoint.searchParams.set("key", YT_API_KEY);

  const response = await fetchWithTimeout(endpoint.toString(), {}, 25000);
  if (!response.ok) return;
  const data = await response.json();
  const candidateIds = (data?.items || [])
    .map((item) => item?.id?.videoId)
    .filter(Boolean);
  if (!candidateIds.length) return;

  const detailsEndpoint = new URL(
    "https://www.googleapis.com/youtube/v3/videos",
  );
  detailsEndpoint.searchParams.set("part", "status");
  detailsEndpoint.searchParams.set("id", candidateIds.join(","));
  detailsEndpoint.searchParams.set("key", YT_API_KEY);

  const detailsResp = await fetchWithTimeout(
    detailsEndpoint.toString(),
    {},
    25000,
  );
  if (!detailsResp.ok) return;
  const detailsData = await detailsResp.json();
  const statusById = Object.fromEntries(
    (detailsData?.items || []).map((v) => [v.id, v]),
  );
  const validIds = candidateIds.filter((id) => {
    const v = statusById[id];
    return (
      v?.status?.embeddable === true && v?.status?.privacyStatus === "public"
    );
  });
  if (!validIds.length) return;

  const hostId = `yt-host-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  videoContainer.classList.remove("hidden-el");
  videoContainer.innerHTML = `
          <div class="yt-player-wrapper w-full h-full min-h-0 bg-black">
            <div id="${hostId}"></div>
          </div>
          <div class="athena-video-footer px-4 py-3 text-xs border-t">
            <a class="yt-watch-link text-indigo-500 hover:text-indigo-400 underline" href="#" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        `;
  const watchLink = videoContainer.querySelector(".yt-watch-link");
  const setWatchHref = (id) => {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    watchLink.href = url;
    videoContainer.dataset.youtubeUrl = url;
  };
  const queue = validIds.slice();
  setWatchHref(queue[0]);

  const measurePlayerSize = () => {
    const wrap = videoContainer.querySelector(".yt-player-wrapper");
    const w = Math.floor(
      (wrap && wrap.getBoundingClientRect().width) ||
        videoContainer.getBoundingClientRect().width ||
        640,
    );
    const width = Math.max(280, w);
    const height = Math.round((width * 9) / 16);
    return { width, height };
  };

  try {
    await loadYouTubeIframeAPI();
  } catch (_) {
    const wrap = videoContainer.querySelector(".yt-player-wrapper");
    if (wrap)
      wrap.innerHTML =
        '<p class="p-4 text-sm text-gray-300 text-center">Could not load the YouTube player.</p>';
    return;
  }

  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  let { width: pW, height: pH } = measurePlayerSize();
  if (pW < 100) {
    pW = 640;
    pH = 360;
  }

  let player;
  const failSlot = videoContainer.querySelector(".yt-player-wrapper");
  const onPlayerError = () => {
    queue.shift();
    if (!queue.length) {
      if (player && typeof player.destroy === "function") player.destroy();
      failSlot.innerHTML =
        '<div class="flex items-center justify-center p-6 text-sm text-gray-300 text-center">These results could not be played inside the page (embedding or rights). Use the link below to watch on YouTube.</div>';
      return;
    }
    setWatchHref(queue[0]);
    player.loadVideoById(queue[0]);
    const { width, height } = measurePlayerSize();
    if (width >= 100) player.setSize(width, height);
  };

  player = new YT.Player(hostId, {
    videoId: queue[0],
    width: pW,
    height: pH,
    playerVars: {
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      origin: window.location.origin,
    },
    events: {
      onReady: (e) => {
        try {
          const { width, height } = measurePlayerSize();
          if (width >= 100) e.target.setSize(width, height);
          const id = e.target.getVideoData().videoId;
          if (id) setWatchHref(id);
        } catch (_) {}
      },
      onError: onPlayerError,
    },
  });

  if (typeof ResizeObserver !== "undefined" && failSlot) {
    const ro = new ResizeObserver(() => {
      if (!player || typeof player.setSize !== "function") return;
      const { width, height } = measurePlayerSize();
      if (width >= 100) player.setSize(width, height);
    });
    ro.observe(failSlot);
  }
}

async function generateResponse(triggerEl) {
  const targetInput =
    triggerEl && triggerEl.tagName === "INPUT"
      ? triggerEl
      : document.getElementById("conceptInput");

  const concept = targetInput.value.trim();
  const major = document.getElementById("majorInput").value.trim();

  const snapImage = pendingImage;
  const snapFile = pendingFile;
  if (!concept && !snapImage && !snapFile) return;

  pendingImage = null;
  pendingFile = null;
  renderAttachmentPreview();

  const sidebarLabel =
    concept ||
    (snapFile ? `File: ${snapFile.name}` : "") ||
    (snapImage ? "Image" : "");
  updateSidebarHistory(sidebarLabel);

  setExplainButtonProcessing(true);
  document.getElementById("loadingState").classList.remove("hidden-el");

  let clone = null;
  try {
    const template = document.getElementById("historyTemplate");
    clone = template.content.cloneNode(true);
    const imgWrap = clone.querySelector(".prompt-image-wrap");
    if (snapImage?.dataUrl) {
      imgWrap.classList.remove("hidden");
      imgWrap.innerHTML = `<img src="${snapImage.dataUrl}" class="max-h-40 w-auto rounded-lg mx-auto block" alt="" />`;
    }
    let promptLabel = concept;
    if (!promptLabel) {
      if (snapFile) promptLabel = `📄 ${snapFile.name}`;
      else if (snapImage) promptLabel = "🖼️ Image";
    } else {
      const bits = [promptLabel];
      if (snapFile) bits.push(`📎 ${snapFile.name}`);
      if (snapImage) bits.push("🖼️");
      promptLabel = bits.join(" · ");
    }
    clone.querySelector(".prompt-text").textContent = promptLabel;

    const outputArea = clone.querySelector(".output-content");
    const prereqs = clone.querySelector(".prerequisite-container");
    const videoContainer = clone.querySelector(".video-container");

    let chatCardInserted = false;
    try {
      const llmJson = await fetchLLMResponse(concept, major, {
        imageDataUrl: snapImage?.dataUrl || null,
        fileText: snapFile?.text || null,
        fileName: snapFile?.name || null,
      });
      const explanation = normalizeExplanation(
        llmJson?.explanation || "No explanation returned.",
      );
      const buildingBlocks = Array.isArray(llmJson?.buildingBlocks)
        ? llmJson.buildingBlocks.slice(0, 3)
        : [];
      const youtubeQuery = String(llmJson?.youtubeSearchQuery || "");
      const jargonTerms = normalizeJargonTerms(llmJson?.jargonTerms);

      outputArea.innerHTML = applyJargonTooltips(
        formatExplanationToHtml(explanation),
        jargonTerms,
      );
      prereqs.innerHTML = "";
      buildingBlocks.forEach((term) => {
        const capsule = document.createElement("button");
        capsule.type = "button";
        capsule.className = "capsule";
        capsule.textContent = term;
        capsule.onclick = () => {
          document.getElementById("conceptInput").value = term;
          generateResponse(document.getElementById("conceptInput"));
        };
        prereqs.appendChild(capsule);
      });

      const historyEl = document.getElementById("chatHistory");
      historyEl.insertBefore(clone, historyEl.firstChild);
      chatCardInserted = true;

      await fetchYouTubeVideo(youtubeQuery, videoContainer);

      let histUser = concept || "";
      if (snapImage) histUser += (histUser ? " " : "") + "[image]";
      if (snapFile)
        histUser += (histUser ? " " : "") + `[file:${snapFile.name}]`;
      if (!histUser.trim())
        histUser = snapImage ? "[image]" : `[file:${snapFile.name}]`;
      chatHistory.push({ role: "user", content: histUser });
      chatHistory.push({
        role: "assistant",
        content: JSON.stringify({
          explanation,
          buildingBlocks,
          youtubeSearchQuery: youtubeQuery,
          jargonTerms,
        }),
      });

      await saveChatToDatabase(
        histUser || promptLabel,
        {
          explanation,
          buildingBlocks,
          youtubeSearchQuery: youtubeQuery,
          jargonTerms,
        },
        currentMode,
        sidebarLabel,
      );
    } catch (error) {
      outputArea.innerHTML = `<p class="text-red-500 dark:text-red-400">${escapeHTML(error.message)}</p>`;
      if (!chatCardInserted) {
        const historyEl = document.getElementById("chatHistory");
        historyEl.insertBefore(clone, historyEl.firstChild);
      }
    }

    saveHistoryState();
  } catch (fatal) {
    console.error(fatal);
    const box = document.getElementById("chatHistory");
    const err = document.createElement("div");
    err.className =
      "text-red-500 p-4 rounded-2xl bg-white dark:bg-slate-800 border border-red-100 dark:border-slate-700";
    err.textContent = `Could not load: ${fatal.message}`;
    box.insertBefore(err, box.firstChild);
  } finally {
    setExplainButtonProcessing(false);
    document.getElementById("loadingState").classList.add("hidden-el");
    targetInput.value = "";
    window.scrollTo({ top: 420, behavior: "smooth" });
  }
}

onAuthStateChanged(auth, (user) => {
  applyAuthVisibility(user !== null);
  updateUserProfileUI(user);
  if (user) {
    loadUserHistory(user.uid);
  } else {
    const list = document.getElementById("historyList");
    if (list) {
      list.innerHTML =
        '<li class="text-xs text-gray-400 italic px-4 list-none">Sign in to see your history…</li>';
    }
  }
});

document.getElementById("signInGoogleBtn")?.addEventListener("click", () => {
  signInWithGoogle();
});
document.getElementById("userProfileSignOut")?.addEventListener("click", () => {
  signOutApp();
});
document.getElementById("sidebarSignOutBtn")?.addEventListener("click", () => {
  signOutApp();
});

Object.assign(window, {
  toggleSidebar,
  toggleAttachmentMenu,
  triggerImagePick,
  triggerFilePick,
  onHiddenImageChange,
  onHiddenFileChange,
  openProfile,
  openSettings,
  closeModal,
  setMode,
  toggleDarkMode,
  handleEnter,
  newChat,
  copyToClipboard,
  generateResponse,
});
