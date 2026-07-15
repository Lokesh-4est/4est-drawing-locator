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

function getConfiguredPropertyNames() {
  const raw = el("propertyNamesInput") ? el("propertyNamesInput").value : "";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// Primary strategy: ask Trimble directly for objects whose named property
// equals the target value. This is a real server-side filtered query - no
// enumeration, no "select everything first" needed - it just requires
// knowing the exact property name(s) your models actually use.
async function findObjectsByKnownProperty(propertyNames, targetValue) {
  const allMatches = []; // { modelId, objectRuntimeIds }
  const details = [];

  for (const propName of propertyNames) {
    let objs;
    try {
      objs = await API.viewer.getObjects({
        parameter: { properties: { [propName]: targetValue } }
      });
    } catch (err) {
      log(`Targeted query on property "${propName}" failed`, err.message);
      continue;
    }

    if (objs && objs.length) {
      for (const o of objs) {
        const ids = o.objectRuntimeIds || [];
        if (ids.length) {
          allMatches.push({ modelId: o.modelId, objectRuntimeIds: ids });
          details.push({ property: propName, modelId: o.modelId, count: ids.length });
        }
      }
    }
  }

  if (details.length) {
    log("Targeted property query found matches", details);
  } else {
    log("Targeted property query found nothing on: " + propertyNames.join(", "));
  }

  return allMatches;
}

// Fallback strategy (only used if the targeted query above finds nothing -
// e.g. the configured property name doesn't match what's actually in this
// model). Pulls the full list of objectRuntimeIds for every loaded model
// and checks every property on every object for an exact match.
async function getAllModelObjectIds() {
  // Attempt 1: unfiltered getObjects()
  try {
    const objs = await API.viewer.getObjects();
    if (objs && objs.length && objs.some(o => (o.objectRuntimeIds || []).length)) {
      const result = objs.map(o => ({ modelId: o.modelId, objectRuntimeIds: o.objectRuntimeIds || [] }));
      log("Fallback: objects retrieved via unfiltered getObjects()", result.map(r => ({ modelId: r.modelId, count: r.objectRuntimeIds.length })));
      return result;
    }
  } catch (err) {
    log("Fallback: getObjects() with no selector failed", err.message);
  }

  const models = await API.viewer.getModels();

  // Attempt 2: walk the hierarchy from the model root.
  const result = [];
  for (const m of models) {
    try {
      const rootChildren = await API.viewer.getHierarchyChildren(m.id, [], undefined, true);
      const ids = (rootChildren || []).map(e => e.id).filter(id => id !== undefined && id !== null);
      if (ids.length) {
        result.push({ modelId: m.id, objectRuntimeIds: ids });
        log(`Fallback: got ${ids.length} object(s) for model ${m.id} via getHierarchyChildren`);
      }
    } catch (err) {
      log(`Fallback: getHierarchyChildren failed for model ${m.id}`, err.message);
    }
  }
  if (result.length) return result;

  // Attempt 3: whatever is currently selected in the viewer.
  try {
    const selection = await API.viewer.getSelection();
    if (selection && selection.length && selection.some(s => (s.objectRuntimeIds || []).length)) {
      const fromSelection = selection.map(s => ({ modelId: s.modelId, objectRuntimeIds: s.objectRuntimeIds || [] }));
      log("Fallback: using current viewer selection as the search scope", fromSelection.map(r => ({ modelId: r.modelId, count: r.objectRuntimeIds.length })));
      return fromSelection;
    }
  } catch (err) {
    log("Fallback: reading current selection failed", err.message);
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

  const propertyNames = getConfiguredPropertyNames();
  if (!propertyNames.length) {
    setResult("No property names configured \u2014 check Advanced settings.", "error");
    return;
  }

  setSearchLoading(true);
  setResult("");
  log("Starting targeted property search", { target, propertyNames });

  let allMatches = [];
  try {
    allMatches = await findObjectsByKnownProperty(propertyNames, target);
  } catch (err) {
    log("Targeted property search failed", err.message);
  }

  let usedFallback = false;

  // Only fall back to the slower brute-force scan if the targeted query
  // truly found nothing - e.g. the configured property name doesn't match
  // this model's actual schema.
  if (!allMatches.length) {
    usedFallback = true;
    log("No match via targeted property query. Falling back to a full property scan.");

    const modelObjectSets = await getAllModelObjectIds();
    if (!modelObjectSets.length) {
      setSearchLoading(false);
      setResult(`Couldn't find "${target}", and couldn't scan the model automatically either. Try selecting the part(s) in the 3D Viewer first, then search again.`, "error");
      return;
    }

    let totalChecked = 0;
    for (const { modelId, objectRuntimeIds } of modelObjectSets) {
      totalChecked += objectRuntimeIds.length;
      const { matchedIds, matchDetails } = await searchModelForValue(modelId, objectRuntimeIds, target);
      if (matchedIds.length) {
        allMatches.push({ modelId, objectRuntimeIds: matchedIds });
        log(`Fallback scan found ${matchedIds.length} matching object(s) in model ${modelId}`, matchDetails);
      }
    }
    log(`Fallback scan finished. Checked ${totalChecked} object(s) across ${modelObjectSets.length} model(s).`);
  }

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
    log("Selection + zoom applied", { selector, usedFallback, totalObjects });
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
