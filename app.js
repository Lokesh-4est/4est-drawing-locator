let API = null;

const state = {
  drawingNo: "",
  drawingNoSource: "",
  events: [],
  selectionCount: 0,
  modelCount: 0
};

function el(id) {
  return document.getElementById(id);
}

function log(message, data) {
  const timestamp = new Date().toLocaleTimeString();
  let line = `[${timestamp}] ${message}`;
  if (data !== undefined) {
    try {
      line += "\n" + JSON.stringify(data, null, 2);
    } catch {
      line += "\n" + String(data);
    }
  }
  const debug = el("debugLog");
  debug.textContent += "\n\n" + line;
  debug.scrollTop = debug.scrollHeight;
  console.log(message, data);
}

function getParamFromUrl(url, key) {
  try {
    if (!url) return "";
    const parsed = new URL(url);
    return parsed.searchParams.get(key) || "";
  } catch {
    return "";
  }
}

function tryReadParentUrl() {
  try {
    return window.parent.location.href || "";
  } catch (err) {
    log("Parent URL access blocked by browser security. This is normal for cross-origin iframes.", err.message);
    return "";
  }
}

function detectDrawingNo() {
  const candidates = [];

  candidates.push({
    source: "extension window.location.href",
    value: getParamFromUrl(window.location.href, "drawingNo")
  });

  candidates.push({
    source: "document.referrer",
    value: getParamFromUrl(document.referrer, "drawingNo")
  });

  const parentUrl = tryReadParentUrl();
  candidates.push({
    source: "window.parent.location.href",
    value: getParamFromUrl(parentUrl, "drawingNo")
  });

  const hash = window.location.hash || "";
  if (hash) {
    candidates.push({
      source: "extension window.location.hash",
      value: getParamFromUrl("https://dummy.local/?" + hash.replace(/^#/, ""), "drawingNo")
    });
  }

  // Fallback for launcher-based testing. Inside Trimble this may be sandboxed,
  // but it is harmless and useful when the plugin opens directly.
  try {
    const stored = localStorage.getItem("4EST_TRIMBLE_LOCATOR_PAYLOAD");
    log("Raw launcher localStorage value", stored);

    if (stored) {
      const payload = JSON.parse(stored);

      candidates.push({
        source: "GitHub launcher localStorage drawingNo",
        value: payload.drawingNo || ""
      });

      candidates.push({
        source: "GitHub launcher localStorage guid",
        value: payload.guid || ""
      });

      log("Launcher payload found", payload);
    }
  } catch (err) {
    log("Could not read launcher localStorage payload", err.message);
  }

  const found = candidates.find(c => c.value && c.value.trim().length > 0);

  log("drawingNo probe candidates", candidates);

  if (found) {
    setDrawingNo(found.value.trim(), found.source);
  } else {
    setDrawingNo("", "No drawingNo found in accessible URL/referrer sources");
  }
}

function setDrawingNo(value, source) {
  state.drawingNo = value || "";
  state.drawingNoSource = source || "";

  const valEl = el("drawingNoValue");
  const srcEl = el("drawingNoSource");
  if (valEl) valEl.textContent = state.drawingNo || "NOT RECEIVED";
  if (srcEl) srcEl.textContent = "Source: " + state.drawingNoSource;

  // Silently pre-fill the main search box if a value was detected and the
  // user hasn't already typed something in themselves.
  const searchInput = el("zoomTargetInput");
  if (searchInput && state.drawingNo && !searchInput.value.trim()) {
    searchInput.value = state.drawingNo;
  }
}

function updateSelectionCount(selection) {
  const el_ = el("selectionCount");
  if (!el_) return;

  const total = (selection || []).reduce((sum, s) => sum + (s.objectRuntimeIds || []).length, 0);
  state.selectionCount = total;

  // Selection is no longer required for normal search.
  // We keep this UI text only as a status/fallback message.
  if (total > 0) {
    el_.textContent = `${total} object(s) selected — optional fallback only. Find & Zoom searches loaded model objects directly.`;
    el_.classList.add("ready");
  } else {
    el_.textContent = "Selection not required — Find & Zoom searches loaded model objects directly.";
    el_.classList.add("ready");
  }
}

async function connectToTrimble() {
  try {
    if (!window.TrimbleConnectWorkspace) {
      setConnectionBanner("Couldn't load the Trimble connection. Try refreshing the page.", "error");
      log("TrimbleConnectWorkspace object missing.");
      return;
    }

    API = await TrimbleConnectWorkspace.connect(window.parent, (event, data) => {
      state.events.push({ event, data });
      log("Workspace event: " + event, data);

      if (event === "extension.command" && data) {
        const raw = typeof data === "string" ? data : JSON.stringify(data);
        const m = raw.match(/drawingNo=([^&"'\s]+)/i);
        if (m && m[1]) {
          setDrawingNo(decodeURIComponent(m[1]), "extension.command event");
        }
      }

      if (event === "viewer.onSelectionChanged") {
        updateSelectionCount(data);
      }
    });

    setConnectionBanner("Connected", "ok");
    log("Connected to Workspace API.");

    try {
      const currentSelection = await API.viewer.getSelection();
      updateSelectionCount(currentSelection);
    } catch (selErr) {
      log("Could not read initial selection", selErr.message);
    }

    try {
      const project = await API.project.getProject();
      el("projectInfo").textContent = JSON.stringify(project, null, 2);
      log("Project loaded", project);
    } catch (projectErr) {
      el("projectInfo").textContent = "Could not read project yet: " + projectErr.message;
      log("Project read failed", projectErr.message);
    }
  } catch (err) {
    setConnectionBanner("Couldn't connect to Trimble Connect. Try refreshing the page.", "error");
    log("Workspace API connection failed", err.message);
  }
}

function setConnectionBanner(text, kind) {
  const banner = el("connectionBanner");
  if (!banner) return;
  banner.textContent = text;
  banner.className = "banner " + (kind === "ok" ? "ok" : kind === "error" ? "error" : "muted");
  if (kind === "ok") {
    // Fade the "Connected" confirmation out after a moment so it doesn't
    // permanently take up space once things are working normally.
    setTimeout(() => {
      if (banner.textContent === "Connected") banner.classList.add("fade");
    }, 2000);
  }
}

function normalizeValue(v) {
  return String(v === undefined || v === null ? "" : v).trim().toLowerCase();
}

// Helper: normalize model id from different API response shapes.
function getModelId(model) {
  if (!model) return "";
  return model.id || model.modelId || model.modelRuntimeId || model.runtimeId || "";
}

function uniqueIds(ids) {
  const seen = new Set();
  const output = [];

  for (const id of ids || []) {
    const key = String(id);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(id);
    }
  }

  return output;
}

function normalizeModelObjectSets(sets) {
  const map = new Map();

  for (const set of sets || []) {
    if (!set) continue;

    const modelId = set.modelId || set.id || set.model || "";
    const ids = set.objectRuntimeIds || set.objects || set.children || [];

    if (!modelId || !Array.isArray(ids) || !ids.length) continue;

    if (!map.has(modelId)) map.set(modelId, []);
    map.get(modelId).push(...ids);
  }

  return Array.from(map.entries()).map(([modelId, ids]) => ({
    modelId,
    objectRuntimeIds: uniqueIds(ids)
  }));
}

// Pulls objectRuntimeIds for currently loaded model objects automatically.
// Area/model selection is no longer required for normal Find & Zoom.
// If Trimble API cannot expose loaded objects, current selection is used only as a backup.
async function getAllModelObjectIds() {
  // Attempt 1: unfiltered getObjects() — best case, gets loaded model objects directly.
  try {
    if (API.viewer.getObjects) {
      const objs = await API.viewer.getObjects();
      const normalized = normalizeModelObjectSets(objs);

      if (normalized.length && normalized.some(o => o.objectRuntimeIds.length)) {
        log("Search scope: loaded objects via unfiltered getObjects()", normalized.map(r => ({
          modelId: r.modelId,
          count: r.objectRuntimeIds.length
        })));
        return normalized;
      }
    }
  } catch (err) {
    log("Search scope attempt failed: getObjects() with no selector", err.message);
  }

  // Attempt 2: get loaded models and ask objects per model using common selector shapes.
  let models = [];
  try {
    if (API.viewer.getModels) {
      models = await API.viewer.getModels();
      state.modelCount = (models || []).length;
      log("Loaded models detected", (models || []).map(m => ({
        id: getModelId(m),
        name: m.name || m.modelName || m.fileName || ""
      })));
    }
  } catch (err) {
    log("Search scope attempt failed: getModels()", err.message);
  }

  const result = [];

  for (const model of models || []) {
    const modelId = getModelId(model);
    if (!modelId) continue;

    const attempts = [
      { label: "getObjects({ modelId })", args: [{ modelId }] },
      { label: "getObjects(modelId)", args: [modelId] },
      { label: "getObjects({ modelObjectIds: [{ modelId }] })", args: [{ modelObjectIds: [{ modelId }] }] }
    ];

    for (const attempt of attempts) {
      try {
        if (!API.viewer.getObjects) continue;

        const objs = await API.viewer.getObjects(...attempt.args);
        const normalized = normalizeModelObjectSets(objs);

        const idsForModel = normalized
          .filter(x => String(x.modelId) === String(modelId))
          .flatMap(x => x.objectRuntimeIds);

        if (idsForModel.length) {
          result.push({ modelId, objectRuntimeIds: uniqueIds(idsForModel) });
          log(`Search scope: ${idsForModel.length} object(s) for model ${modelId} via ${attempt.label}`);
          break;
        }
      } catch (err) {
        log(`Search scope attempt failed for model ${modelId}: ${attempt.label}`, err.message);
      }
    }
  }

  if (result.length) {
    return normalizeModelObjectSets(result);
  }

  // Attempt 3: hierarchy fallback.
  for (const model of models || []) {
    const modelId = getModelId(model);
    if (!modelId) continue;

    try {
      if (!API.viewer.getHierarchyChildren) continue;

      const rootChildren = await API.viewer.getHierarchyChildren(modelId, [], undefined, true);
      const ids = (rootChildren || [])
        .map(e => e.id || e.objectRuntimeId || e.runtimeId)
        .filter(id => id !== undefined && id !== null);

      if (ids.length) {
        result.push({ modelId, objectRuntimeIds: uniqueIds(ids) });
        log(`Search scope: ${ids.length} object(s) for model ${modelId} via hierarchy`);
      }
    } catch (err) {
      log(`Search scope attempt failed for model ${modelId}: hierarchy`, err.message);
    }
  }

  if (result.length) {
    return normalizeModelObjectSets(result);
  }

  // Final backup only: current viewer selection.
  try {
    const selection = await API.viewer.getSelection();
    const fromSelection = normalizeModelObjectSets(selection);

    if (fromSelection.length && fromSelection.some(s => s.objectRuntimeIds.length)) {
      log("Search scope fallback: current viewer selection", fromSelection.map(r => ({
        modelId: r.modelId,
        count: r.objectRuntimeIds.length
      })));
      return fromSelection;
    }
  } catch (err) {
    log("Search scope fallback failed: current selection", err.message);
  }

  return [];
}

// Fetches object properties in batches and returns objectRuntimeIds whose
// properties contain a value matching targetValue (case-insensitive, exact match).
async function searchModelForValue(modelId, objectRuntimeIds, targetValue, batchSize = 200) {
  const targetNorm = normalizeValue(targetValue);
  const matchedIds = [];
  const matchDetails = [];

  for (let i = 0; i < objectRuntimeIds.length; i += batchSize) {
    const batch = objectRuntimeIds.slice(i, i + batchSize);
    let propsList;
    try {
      propsList = await API.viewer.getObjectProperties(modelId, batch);
    } catch (err) {
      log(`getObjectProperties failed for model ${modelId}, batch starting at ${i}`, err.message);
      continue;
    }

    for (const obj of propsList) {
      const sets = obj.properties || [];
      let found = false;
      for (const set of sets) {
        const props = set.properties || [];
        for (const p of props) {
          const valueNorm = normalizeValue(p.value);
          const compactValue = valueNorm.replace(/\s+/g, "");
          const compactTarget = targetNorm.replace(/\s+/g, "");

          if (valueNorm === targetNorm || compactValue === compactTarget) {
            matchDetails.push({ objectId: obj.id, set: set.set, property: p.name, value: p.value });
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (found) matchedIds.push(obj.id);
    }
  }

  return { matchedIds, matchDetails };
}

function setSearchLoading(isLoading) {
  const btn = el("findZoomButton");
  if (!btn) return;
  btn.disabled = isLoading;
  btn.querySelector(".btn-label").textContent = isLoading ? "Searching..." : "Find & Zoom";
  const spinner = btn.querySelector(".btn-spinner");
  if (spinner) spinner.hidden = !isLoading;
}

function setResult(message, kind) {
  const status = el("zoomStatus");
  if (!status) return;
  status.textContent = message;
  status.className = "result " + (kind || "");
}

async function findAndZoomToDrawing() {
  if (!API) {
    setResult("Still connecting to Trimble Connect \u2014 try again in a moment.", "error");
    return;
  }

  const target = el("zoomTargetInput").value.trim();
  if (!target) {
    setResult("Type something to search for first.", "error");
    return;
  }

  setSearchLoading(true);
  setResult("");
  log("Starting direct search across loaded model objects", { target });

  const allMatches = [];

  const modelObjectSets = await getAllModelObjectIds();
  if (!modelObjectSets.length) {
    setSearchLoading(false);
    setResult(`Couldn't find "${target}" \u2014 couldn't read any objects from the model. Try selecting the part(s) in the 3D Viewer first, then search again.`, "error");
    return;
  }

  let totalChecked = 0;
  for (const { modelId, objectRuntimeIds } of modelObjectSets) {
    totalChecked += objectRuntimeIds.length;
    const { matchedIds, matchDetails } = await searchModelForValue(modelId, objectRuntimeIds, target);
    if (matchedIds.length) {
      allMatches.push({ modelId, objectRuntimeIds: matchedIds });
      log(`Found ${matchedIds.length} matching object(s) in model ${modelId}`, matchDetails);
    }
  }
  log(`Direct search finished. Checked ${totalChecked} object(s) across ${modelObjectSets.length} model scope(s).`);

  setSearchLoading(false);

  if (!allMatches.length) {
    setResult(`\u274c Couldn't find anything matching "${target}". Double-check the value and try again.`, "error");
    return;
  }

  const totalObjects = allMatches.reduce((sum, m) => sum + m.objectRuntimeIds.length, 0);
  const selector = { modelObjectIds: allMatches };

  try {
    await API.viewer.setSelection(selector, "set");
    await API.viewer.setCamera(selector, { animationTime: 800 });

    if (totalObjects > 1) {
      setResult(`\u26a0\ufe0f Found ${totalObjects} parts matching "${target}" \u2014 they're not unique, so all ${totalObjects} are shown together.`, "warn");
    } else {
      setResult(`\u2705 Found it \u2014 zoomed to "${target}".`, "ok");
    }
    log("Selection + zoom applied", { selector, totalObjects });
  } catch (err) {
    setResult("Found a match, but couldn't select/zoom to it. Try again.", "error");
    log("setSelection/setCamera failed", err.message);
  }
}

async function inspectSelection() {
  if (!API) {
    setResult("Still connecting to Trimble Connect \u2014 try again in a moment.", "error");
    return;
  }

  try {
    const selection = await API.viewer.getSelection();
    if (!selection || !selection.length) {
      setResult("Nothing is selected in the 3D Viewer. Click a part in the model first, then try this again.", "error");
      return;
    }

    for (const sel of selection) {
      const ids = (sel.objectRuntimeIds || []).slice(0, 5);
      if (!ids.length) continue;
      const props = await API.viewer.getObjectProperties(sel.modelId, ids);
      log(`Properties for selected object(s) in model ${sel.modelId}`, props);
    }

    setResult("Properties printed to the debug log below \u2014 look for the field name/value you want to search by.", "ok");
  } catch (err) {
    setResult("Couldn't read the selected part's properties.", "error");
    log("Inspect selection failed", err.message);
  }
}

function setupZoomButtons() {
  const findBtn = el("findZoomButton");
  const inspectBtn = el("inspectButton");
  const input = el("zoomTargetInput");

  if (findBtn) findBtn.addEventListener("click", findAndZoomToDrawing);
  if (inspectBtn) inspectBtn.addEventListener("click", inspectSelection);

  if (input) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        findAndZoomToDrawing();
      }
    });
  }
}

(async function main() {
  el("debugLog").textContent = "Starting 4EST Part Locator — direct loaded-model search...";
  setupZoomButtons();
  detectDrawingNo();
  await connectToTrimble();

  log("MVP ready. Area/model selection is no longer required for normal Find & Zoom.");
})();
