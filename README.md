# AGANIM: Israel & Neighbors

A lightweight English/Hebrew terrain explorer for Israel, Lebanon, Syria, Jordan, Egypt and the Palestinian territories. Built with React, Vite, Leaflet, Lucide and d3-contour. No API key, account or backend is required.

## Run

```sh
npm install
npm run dev -- --port 5173
```

Open http://localhost:5173. On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`. Vite selects the next available port if 5173 is occupied.

```sh
npm test
npm run build
```

## Workflow

- AGANIM opens on a clean regional map: no selected point, example basin or DEM calculation. Choose a country shortcut or select your first point. Existing browser terrain cache is not automatically drawn on the map.
- The header language button switches between English (LTR) and Hebrew (RTL). The preference survives reloads. Changing language preserves the selected point and calculation; map coordinates remain LTR. Preset search accepts either English or Hebrew place names.
- Select any map point, search a place, or enter `latitude, longitude`. Search presets include Mount Hermon, Beirut, Damascus, Amman, Jerusalem, the Sea of Galilee and Nahal Zin.
- Selecting a point, including a map click, automatically loads terrain if needed and adds a numbered **watershed and its surrounding drainage divide** at that exact point. Existing analyses stay on the map. DEM processing and watershed calculations run in a background Web Worker rather than blocking the map.
- **Red lines** mark the modeled watershed drainage divide; **blue lines** show the modeled streams, with a dashed blue downstream path. The divide often follows ridges, but is not an elevation contour or a survey of every ridge. Ordinary elevation contours remain a separate optional layer. On partial results, boundary segments at the DEM edge are coverage limits, not detected ridges.
- A nearby modeled channel, when found within 650 m, is proposed explicitly. The initial result still uses the original point. Both points remain visible until the user approves moving the outlet or keeps the original point. **Analyze watershed & divide** recalculates the selected analysis in place; accepting a snap also updates that analysis rather than adding a duplicate.
- **Map analyses** lists the retained numbered results. Select a row to inspect its metrics and center the map; use its remove button to delete just that analysis. The list's fit icon shows all retained basins. Each analysis retains its original model and geographic outlet, so loading a different region does not relocate earlier results.
- Give each basin a name in its editable field in the analysis list. The name stays with that analysis through recalculation, outlet snapping, switching between results and export, without changing its location or geometry. Names are included as GeoJSON `analysis_name` properties.
- **Clear map** removes all analyses, selected-point markers, profiles and the area of interest, and invalidates any running calculation so a late reply cannot redraw a cleared result. It does not erase the local terrain cache or change the language preference.
- There are no separate watershed/terrain tabs or comparison mode. Optional elevation profiles are grouped under the selected analysis. **Generate elevation profiles** creates two 5 km transects; hovering a profile highlights its location. Additional point-centered profiles can be drawn at any bearing.
- Draw an area of interest by selecting two opposite corners. This focuses the map and never clips a watershed.
- The map keeps only search, zoom, point centering, temporary drawing messages and optional profiles. **Fit watershed**, area drawing, elevation metadata, the legend and layer toggles are in the analysis sidebar. The profile panel reserves a separate rail for map controls so it cannot cover zoom buttons.
- Toggle drainage, contours, hillshade and satellite imagery. Stream overlays belong to retained basins rather than leaving a separate regional network behind after removal. Export all retained analyses as GeoJSON, including each boundary, drainage network and downstream path, with stable analysis metadata. Removed analyses are excluded. The map composition lasts for the current page session only; reload starts clean. Export before reloading for a permanent copy.

## Local Cache & Performance

- **Cache terrain & watersheds** is enabled by default in the Local storage section. It persists decoded DEM tiles, processed flow models and calculated outlet geometries in IndexedDB on this device, including across page reloads. No user account or server-side storage is involved.
- Repeat analysis within the active terrain window reuses its in-memory flow model. Revisiting a saved window skips tile downloads and hydrological preprocessing. Repeating an outlet reuses its stored watershed boundary and drainage geometry.
- The cache is versioned by the algorithm and indexed by terrain tile window and outlet cell. Nearby windows can reuse overlapping decoded tiles. Models use a stable window-centered pixel scale so cached geometry and area are consistent.
- A 128 MiB approximate data budget bounds storage, with least-recently-used eviction. The UI shows usage, terrain-area counts, watershed counts, and analysis time. Browser storage overhead is not included in that estimate; actual browser quotas can be lower.
- The trash icon clears cached tiles, models and watersheds without removing the current map. Disabling the toggle stops cache reads and writes but does not delete existing data. The enabled preference survives a reload. Browser storage being blocked or full does not prevent uncached analysis.
- Cached data is best-effort browser storage, not a backup. Private browsing, clearing site data or browser storage pressure can remove it. Reloading the app itself, basemaps, imagery, fonts, place search and previously unvisited terrain may still need internet. This does not pre-download Israel and its neighbors or provide a fully offline application.
- A measured run in the test browser took 1,235 ms with an empty application cache and 220 ms on reload with DEM requests blocked: approximately 5.6 times faster, with zero DEM requests. Repeating a cached wadi outlet within the active window took 47 ms. These are analysis timings, not guaranteed frame or full-page load times; network, hardware and basin complexity affect performance.

## Data & Limits

- **Elevation:** Mapzen / AWS public Terrarium elevation tiles, zoom 12. A 3 by 3 tile window is downloaded per analysis location, approximately 25 by 25 km in this region. Grid spacing is about 32 m; native source resolution, vertical datum and accuracy can vary. Grid spacing is not a guarantee of survey accuracy.
- **Hydrology:** Priority-flood depression filling followed by D8 flow direction and accumulation, computed locally from the downloaded DEM. Raster boundaries use d3-contour. Areas use the local projected pixel scale.
- Catchments reaching any edge of the available DEM are marked **partial**. The map shows the entire computed catchment even outside the area of interest. Downstream paths stop at the DEM boundary.
- Small wadis, narrow ridges, culverts, terraces and sub-grid catchments may be missed. Filling depressions can produce artificial paths across lakes. Karst, groundwater, drainage engineering, rainfall and flood hydraulics are not modeled.
- Elevations are nearest-cell samples. Profiles have 121 samples and show gaps beyond DEM coverage. Tiny catchments are displayed as `< 0.01 km2`, not as zero.
- **Maps:** Esri World Topographic, World Imagery and World Hillshade. Attribution remains on the map. Political labels and boundaries follow the map provider.
- **Place search:** OpenStreetMap Nominatim, bounded to the wider region. Preset search, coordinate input and point selection remain available if geocoding fails.
- No validated regional classified land-cover data is bundled, so no land-cover layer is represented as available.
- Internet access is required for uncached elevation tiles, external map tiles and search. Cached terrain analysis can run without DEM network access after the app has loaded. Failed or missing data produces an explicit error and retry action. No mock results are substituted.
- This is an exploratory tool, not an engineering calculation, flood warning system or authoritative boundary dataset.

## Verification

The thirteen automated tests cover editable analysis names, name persistence and GeoJSON export, retained analyses across distinct DEM windows, stable-ID updates, individual deletion, clear-all, multi-analysis export metadata, English/Hebrew labels and interpolated messages, upstream/downstream containment, closed GeoJSON boundaries and drainage export, partial coverage flags, point-centered profiles, nonmutating snapping, typed-array cache persistence, disable/clear controls, bounded eviction, exact result reuse and storage-unavailable fallback. The production build includes a separate terrain worker bundle.

Browser checks performed with live terrain data:

| Check | Result |
| --- | --- |
| Regional map and country shortcut | Map tiles rendered; Lebanon shortcut changed the view. |
| Clean start and AGANIM branding | Initial title and header use AGANIM. Zero analyses, outlet markers, selected-point markers, loading indicators or startup DEM requests, even with cached terrain available. |
| Retained map analyses | Added two Mount Hermon catchments and a Nahal Zin analysis: all three remained with numbered map outlets. Loading the third region did not change the first boundary geometry. |
| Targeted update and removal | Recalculation and channel snapping kept the same analysis ID and total count. Removing an inactive entry removed only its layers; removing the active entry selected a remaining analysis without relocating its outlet. |
| Clear and stale calculations | Clear removed all visible results and selected-point markers without changing cache usage. Also cleared while DEM requests were held, then released failed worker replies: no result, marker, loading indicator or error reappeared. |
| Automatic point analysis | A coordinate selection calculated immediately without a calculate-button click. The exact original coordinates remained unchanged until an optional 287 m channel proposal was accepted. |
| Divide / stream colors | Desktop screenshot and vector-canvas pixel checks confirmed red drainage divides and blue streams. |
| Persistent cache speed | Cleared local cache, analyzed, reloaded with DEM requests blocked: the same catchment restored in 220 ms with zero DEM requests versus 1,235 ms for the cleared-cache run. Repeated outlet analysis took 47 ms. |
| Cache disable and recovery | Disabled caching, blocked DEM downloads and reloaded: nine tile requests failed with a clear message and no stale result. Re-enabled caching and retried: saved terrain restored in 78 ms. |
| Mount Hermon elevation | DEM elevation was 2,805 m at 33.4162, 35.8575. |
| Two summit profiles | North/south and east/west profiles rendered with labeled axes. Hover changed the map marker, verified with a vector-canvas pixel comparison. |
| Custom profile | A drawn 59-degree transect rendered with its actual bearing and correct custom-direction label. |
| Small summit catchment | Site explained that little upslope area drains there and suggested a wadi outlet downslope. |
| Unified analysis workflow | No separate watershed/terrain tabs. One analysis contains the catchment boundary, red drainage divide and blue streams. |
| English / Hebrew | Language switch updates labels, notices, map tooltips, dialogs and profile axes, moves the Hebrew sidebar to the right, and persists after reload without changing the calculated area. Hebrew preset search found Mount Hermon and displayed 2,805 m. |
| Unobscured zoom | With profiles open, zoom-out remained visible and hit-testable at 1440 by 1000, 960 by 650, 768 by 1024, 390 by 844 and 320 by 640 in both English and Hebrew. No horizontal overflow. Fit and elevation metadata are outside the map. |
| Real-data containment | Every one of 3,079 upstream cells was present in the downstream catchment of 5,591 cells on the same modeled channel. |
| Explicit snapping | A 287 m proposal displayed both points, left the original coordinates unchanged, and waited for confirmation. Both the proposed and original-point choices were exercised. |
| GeoJSON | Three retained analyses exported nine features with three analysis IDs: a MultiPolygon, MultiLineString and LineString per result. Earlier geometry was unchanged after loading a different DEM window. Boundary closure and excluding deleted analyses are also covered by automated tests. The VS Code integrated browser did not expose a download event or save a file to Downloads, so filesystem download completion was not verified there. |
| Layers | Contour toggling rendered; topographic tiles, hillshade and the drainage overlay loaded. |
| Failure and recovery | Intercepted DEM requests to force failure: a clear error appeared, no sample result was shown, and retry recovered after restoring requests. |
| Responsive layout | Desktop 1440 by 1000 and mobile 390 by 844 inspected. Mobile had no horizontal overflow. |

These are functional checks, not scientific validation against an independently surveyed watershed dataset. Live provider datasets can change, so measured values are not fixed regression fixtures.