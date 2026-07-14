let API = null;

const state = {
  drawingNo: "",
  drawingNoSource: "",
  events: []
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

  el("drawingNoValue").textContent = state.drawingNo || "NOT RECEIVED";
  el("drawingNoSource").textContent = "Source: " + state.drawingNoSource;
}

async function connectToTrimble() {
  try {
    if (!window.TrimbleConnectWorkspace) {
      el("connectionStatus").textContent = "Workspace API script not loaded.";
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
    });

    el("connectionStatus").textContent = "Connected to Trimble Workspace API.";
    log("Connected to Workspace API.");

    try {
      const project = await API.project.getProject();
      el("projectInfo").textContent = JSON.stringify(project, null, 2);
      log("Project loaded", project);
    } catch (projectErr) {
      el("projectInfo").textContent = "Could not read project yet: " + projectErr.message;
      log("Project read failed", projectErr.message);
    }
  } catch (err) {
    el("connectionStatus").textContent = "Connection failed: " + err.message;
    log("Workspace API connection failed", err.message);
  }
}

function setupManualButton() {
  el("manualButton").addEventListener("click", () => {
    const value = el("manualDrawingNo").value.trim();
    setDrawingNo(value, "manual input");
    log("Manual drawingNo set", value);
  });
}

function normalizeValue(v) {
  return String(v === undefined || v === null ? "" : v).trim().toLowerCase();
}

// Pulls the full list of objectRuntimeIds for every loaded model.
async function getAllModelObjectIds() {
  // Calling getObjects() with no selector returns every object across all
  // currently loaded models, grouped by model. This avoids relying on a
  // modelId value from getModels() that may not line up with what the
  // viewer expects internally.
  let objs;
  try {
    objs = await API.viewer.getObjects();
  } catch (err) {
    log("getObjects() with no selector failed, trying per-model fallback", err.message);
    objs = null;
  }

  const result = [];

  if (objs && objs.length && objs.some(o => (o.objectRuntimeIds || []).length)) {
    for (const o of objs) {
      result.push({ modelId: o.modelId, objectRuntimeIds: o.objectRuntimeIds || [] });
    }
    log("Objects retrieved via unfiltered getObjects()", result.map(r => ({ modelId: r.modelId, count: r.objectRuntimeIds.length })));
    return result;
  }

  // Fallback: try per-model, both with and without recursive, in case the
  // unfiltered call returned nothing on this project.
  const models = await API.viewer.getModels();
  log("Loaded models", models.map(m => ({ id: m.id, name: m.name })));

  for (const m of models) {
    let found = [];
    for (const recursive of [true, false]) {
      try {
        const modelObjs = await API.viewer.getObjects({
          modelObjectIds: [{ modelId: m.id, recursive }]
        });
        const ids = modelObjs.flatMap(o => o.objectRuntimeIds || []);
        if (ids.length) {
          found = ids;
          log(`Got ${ids.length} object(s) for model ${m.id} (recursive=${recursive})`);
          break;
        }
      } catch (err) {
        log(`getObjects failed for model ${m.id} (recursive=${recursive})`, err.message);
      }
    }
    if (found.length) {
      result.push({ modelId: m.id, objectRuntimeIds: found });
    } else {
      log(`No objects found for model ${m.id} (${m.name}) via any method.`);
    }
  }

  return result;
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

async function findAndZoomToDrawing() {
  const status = el("zoomStatus");

  if (!API) {
    status.textContent = "Not connected to Trimble Workspace API yet. Wait for connection, then try again.";
    return;
  }

  const manualTarget = el("zoomTargetInput").value.trim();
  const detected = (state.drawingNo || "").trim();
  const target = manualTarget || detected;

  if (!target) {
    status.textContent = "No value to search for. Enter one in the box above, or make sure a drawingNo was detected higher up.";
    return;
  }

  status.textContent = `Searching loaded model(s) for "${target}"...`;
  log("Starting object search", { target });

  let modelObjectSets;
  try {
    modelObjectSets = await getAllModelObjectIds();
  } catch (err) {
    status.textContent = "Failed to read models from the viewer: " + err.message;
    log("getModels/getObjects failed", err.message);
    return;
  }

  const allMatches = [];
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

  if (!allMatches.length) {
    status.textContent = `No object found with a property value matching "${target}". Click "Inspect current selection" on a known object in the model to see its actual property names/values, then we can tune the match.`;
    return;
  }

  const selector = { modelObjectIds: allMatches };

  try {
    await API.viewer.setSelection(selector, "set");
    await API.viewer.setCamera(selector, { animationTime: 800 });
    const totalObjects = allMatches.reduce((sum, m) => sum + m.objectRuntimeIds.length, 0);
    status.textContent = `Selected and zoomed to ${totalObjects} object(s) matching "${target}".`;
    log("Selection + zoom applied", selector);
  } catch (err) {
    status.textContent = "Match found but select/zoom failed: " + err.message;
    log("setSelection/setCamera failed", err.message);
  }
}

async function inspectSelection() {
  const status = el("zoomStatus");

  if (!API) {
    status.textContent = "Not connected to Trimble Workspace API yet.";
    return;
  }

  try {
    const selection = await API.viewer.getSelection();
    if (!selection || !selection.length) {
      status.textContent = "Nothing is selected in the 3D Viewer. Click a part in the model first, then press Inspect.";
      return;
    }

    for (const sel of selection) {
      const ids = (sel.objectRuntimeIds || []).slice(0, 5);
      if (!ids.length) continue;
      const props = await API.viewer.getObjectProperties(sel.modelId, ids);
      log(`Properties for selected object(s) in model ${sel.modelId}`, props);
    }

    status.textContent = "Properties of the currently selected object(s) were printed to the debug log below \u2014 look there for the property name/value that matches your drawing number.";
  } catch (err) {
    status.textContent = "Inspect failed: " + err.message;
    log("Inspect selection failed", err.message);
  }
}

function setupZoomButtons() {
  el("findZoomButton").addEventListener("click", findAndZoomToDrawing);
  el("inspectButton").addEventListener("click", inspectSelection);
}

(async function main() {
  el("debugLog").textContent = "Starting 4EST Drawing Locator MVP 1...";
  setupManualButton();
  setupZoomButtons();
  detectDrawingNo();
  await connectToTrimble();

  log("MVP 1 ready. Use 'Find & Zoom' to select/zoom to the matching part, or 'Inspect current selection' to see property names.");
})();
