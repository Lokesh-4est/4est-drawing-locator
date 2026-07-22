let API = null;

const state = {
  drawingNo: "",
  drawingNoSource: "",
  events: [],
  selectionCount: 0
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

  if (total > 0) {
    el_.textContent = `${total} object(s) currently selected \u2014 ready to search`;
    el_.classList.add("ready");
  } else {
    el_.textContent = "No selection detected yet \u2014 click the model, then press Ctrl+A";
    el_.classList.remove("ready");
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

// Pulls the full list of objectRuntimeIds for every loaded model, so every
// property on every object can be checked. Tries a few strategies since
// Trimble's API doesn't have one reliable "give me everything" call on all
// projects:
async function getAllModelObjectIds() {
  /*
    DIRECT SEARCH V2

    Reason for this update:
    In your debug log, unfiltered viewer.getObjects() returned only 5 IDs across 5 models.
    That means it was returning only model root/container IDs, not real leaf part IDs.
    We now reject that small root-only result and try hierarchy expansion first.

    If hierarchy expansion is blocked by Trimble API, the function still falls back
    to current selection, so the old area-selection method remains available as backup.
  */

  const models = await getLoadedModelsSafe();

  // Attempt 1: viewer.getObjects() probe.
  // Accept it only if it returns a useful number of object ids.
  try {
    const objs = await API.viewer.getObjects();
    const normalized = normalizeModelObjectSets(objs);
    const total = normalized.reduce((sum, r) => sum + r.objectRuntimeIds.length, 0);

    log("Search scope probe: unfiltered getObjects()", normalized.map(r => ({
      modelId: r.modelId,
      count: r.objectRuntimeIds.length
    })));

    if (total > 25 || normalized.some(o => o.objectRuntimeIds.length > 25)) {
      log("Search scope accepted: getObjects() returned enough object ids.", normalized.map(r => ({
        modelId: r.modelId,
        count: r.objectRuntimeIds.length
      })));
      return normalized;
    }

    log("Search scope rejected: getObjects() returned only root/container ids, trying hierarchy expansion.");
  } catch (err) {
    log("Search scope probe failed: getObjects()", err.message);
  }

  // Attempt 2: recursively collect hierarchy object ids from each loaded model.
  const hierarchyResults = [];

  for (const model of models) {
    const modelId = getModelId(model);
    if (!modelId) continue;

    const ids = await collectHierarchyObjectIds(modelId);

    if (ids.length) {
      hierarchyResults.push({ modelId, objectRuntimeIds: uniqueIds(ids) });
      log(`Search scope probe: hierarchy collected ${ids.length} id(s) for model ${modelId}`);
    }
  }

  const hierarchyTotal = hierarchyResults.reduce((sum, r) => sum + r.objectRuntimeIds.length, 0);

  if (hierarchyTotal > 25) {
    log("Search scope accepted: hierarchy expansion.", hierarchyResults.map(r => ({
      modelId: r.modelId,
      count: r.objectRuntimeIds.length
    })));
    return hierarchyResults;
  }

  if (hierarchyTotal > 0) {
    log("Search scope rejected: hierarchy returned too few ids, trying selector variants.", hierarchyResults.map(r => ({
      modelId: r.modelId,
      count: r.objectRuntimeIds.length
    })));
  }

  // Attempt 3: model-specific getObjects selector variants.
  const selectorResults = [];

  for (const model of models) {
    const modelId = getModelId(model);
    if (!modelId) continue;

    const attempts = [
      { label: "getObjects({modelId})", args: [{ modelId }] },
      { label: "getObjects(modelId)", args: [modelId] },
      { label: "getObjects({modelId, recursive:true})", args: [{ modelId, recursive: true }] },
      { label: "getObjects({modelId, includeChildren:true})", args: [{ modelId, includeChildren: true }] },
      { label: "getObjects({modelObjectIds:[{modelId}]})", args: [{ modelObjectIds: [{ modelId }] }] }
    ];

    for (const attempt of attempts) {
      try {
        const objs = await API.viewer.getObjects(...attempt.args);
        const normalized = normalizeModelObjectSets(objs);
        const idsForModel = normalized
          .filter(x => String(x.modelId) === String(modelId))
          .flatMap(x => x.objectRuntimeIds);

        if (idsForModel.length > 25) {
          selectorResults.push({
            modelId,
            objectRuntimeIds: uniqueIds(idsForModel)
          });

          log(`Search scope accepted: ${idsForModel.length} id(s) for model ${modelId} via ${attempt.label}`);
          break;
        }

        if (idsForModel.length) {
          log(`Search scope rejected: ${attempt.label} for model ${modelId} returned only ${idsForModel.length} id(s).`);
        }
      } catch (err) {
        log(`Search scope attempt failed: ${attempt.label} for model ${modelId}`, err.message);
      }
    }
  }

  if (selectorResults.length) {
    return selectorResults;
  }

  // Final fallback: selected/area-selected objects.
  try {
    const selection = await API.viewer.getSelection();
    const fromSelection = normalizeModelObjectSets(selection);

    if (fromSelection.length && fromSelection.some(s => (s.objectRuntimeIds || []).length)) {
      log("Search scope fallback: using current viewer selection", fromSelection.map(r => ({
        modelId: r.modelId,
        count: r.objectRuntimeIds.length
      })));
      return fromSelection;
    }
  } catch (err) {
    log("Fallback: reading current selection failed", err.message);
  }

  return [];
}

async function getLoadedModelsSafe() {
  try {
    if (!API.viewer.getModels) return [];
    const models = await API.viewer.getModels();
    log("Loaded models detected for direct search", (models || []).map(m => ({
      id: getModelId(m),
      name: m.name || m.modelName || m.fileName || ""
    })));
    return models || [];
  } catch (err) {
    log("Could not read loaded models", err.message);
    return [];
  }
}

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

async function collectHierarchyObjectIds(modelId) {
  const collected = [];
  const visited = new Set();
  const maxDepth = 20;
  const maxIds = 50000;

  function getNodeId(node) {
    if (!node) return null;
    return node.id ?? node.objectRuntimeId ?? node.runtimeId ?? node.objectId ?? null;
  }

  async function getChildren(parentIds) {
    const attempts = [
      { label: "getHierarchyChildren(modelId, parentIds, undefined, true)", args: [modelId, parentIds, undefined, true] },
      { label: "getHierarchyChildren(modelId, parentIds)", args: [modelId, parentIds] },
      { label: "getHierarchyChildren({modelId, objectRuntimeIds})", args: [{ modelId, objectRuntimeIds: parentIds }] },
      { label: "getHierarchyChildren({modelId, parentIds})", args: [{ modelId, parentIds }] }
    ];

    for (const attempt of attempts) {
      try {
        if (!API.viewer.getHierarchyChildren) continue;
        const children = await API.viewer.getHierarchyChildren(...attempt.args);

        if (Array.isArray(children)) {
          return children;
        }
      } catch (err) {
        // Try next signature.
      }
    }

    return [];
  }

  const roots = await getChildren([]);

  log(`Hierarchy root probe for model ${modelId}`, {
    rootCount: roots.length,
    sample: roots.slice(0, 5)
  });

  const queue = [];

  for (const root of roots) {
    const id = getNodeId(root);
    if (id === null || id === undefined) continue;
    queue.push({ id, depth: 0 });
  }

  while (queue.length && collected.length < maxIds) {
    const item = queue.shift();
    const key = String(item.id);

    if (visited.has(key)) continue;
    visited.add(key);

    collected.push(item.id);

    if (item.depth >= maxDepth) continue;

    const children = await getChildren([item.id]);
    for (const child of children || []) {
      const childId = getNodeId(child);
      if (childId === null || childId === undefined) continue;
      queue.push({ id: childId, depth: item.depth + 1 });
    }
  }

  log(`Hierarchy collection finished for model ${modelId}`, {
    collected: collected.length,
    visited: visited.size
  });

  return uniqueIds(collected);
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
          if (normalizeValue(p.value) === targetNorm) {
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
  log("Starting open search (any property, any object)", { target });

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
  log(`Search finished. Checked ${totalChecked} object(s) across ${modelObjectSets.length} model(s).`);

  setSearchLoading(false);

  if (!allMatches.length) {
    setResult(`❌ Couldn\'t find anything matching "${target}". If debug shows only a few objects checked, Trimble is exposing only root containers and area selection is still needed as fallback.`, "error");
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
  el("findZoomButton").addEventListener("click", findAndZoomToDrawing);
  el("inspectButton").addEventListener("click", inspectSelection);
}

(async function main() {
  el("debugLog").textContent = "Starting 4EST Drawing Locator MVP 1...";
  setupZoomButtons();
  detectDrawingNo();
  await connectToTrimble();

  log("MVP 1 ready.");
})();
