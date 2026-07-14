4EST Drawing Locator MVP 1 (with Find & Zoom)

Purpose:
- Trimble Connect extension probe + object locator.
- Confirms whether drawingNo from the PDF URL is visible to the extension.
- Can now search all loaded model objects for a matching property value,
  then select and zoom the 3D Viewer camera to it.

How Find & Zoom works:
- Click "Find & Zoom." It uses the drawingNo detected above (or whatever
  you type into the box) as the search value.
- It pulls every object from every loaded model and checks all of their
  properties for an exact (case-insensitive) match.
- On a match, it selects the object(s) in the viewer and zooms/fits the
  camera to them.
- If nothing matches, select a known part manually in the viewer and click
  "Inspect current selection" - this prints that object's actual property
  names/values to the debug log, so you can confirm which property holds
  the drawing number/mark in your model.

Note: for large models this brute-force scan can be slow (it fetches
properties in batches of 200 objects). If you already know the exact
property set/name that stores the drawing number (e.g. "Mark",
"AssemblyMark", a custom Pset), that can be wired in as a fast, targeted
query instead - ask for that as a follow-up if needed.

Files:
- manifest.json
- index.html
- app.js
- style.css
- icon.svg
- help.html

How to test locally:
1. Open this folder in VS Code.
2. Use a static server:
   npx http-server . -p 8080 --cors
3. Expose with ngrok/cloudflare tunnel if Trimble requires public HTTPS.
4. Add the extension in Trimble Connect 3D Viewer settings using the manifest URL.
5. Open your PDF link with &drawingNo=LGSF31.
6. Open the 4EST Drawing Locator tab in the 3D Viewer.
7. Check if it displays LGSF31.

Next:
- If drawingNo is visible, build object search/select.
- If not visible, use a launcher/redirect approach or supported viewId workflow.
