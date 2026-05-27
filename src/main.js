import './style.css';

// Grid preset dimensions (cols × rows) and fixed tile pixel size
const MAP_PRESETS = {
    '48x34':   { cols: 48,  rows: 34 },
    '68x48':   { cols: 68,  rows: 48 },
    '88x68':   { cols: 88,  rows: 68 },
    '118x78':  { cols: 118, rows: 78 }
};

const TILE_SIZE = 32;

// Terrain name-to-numeric-ID lookup
const TERRAIN_TYPES = {
    'grass': 0, 'asphalt': 1, 'arched-cobblestone': 2, 'tiles': 3,
    'concrete': 4, 'wooden-boards': 5, 'steel-plate': 6, 'cherry-blossoms': 7,
    'snow': 8, 'sand': 9, 'gravel': 10, 'sea': 11, 'gold-tiles': 12,
    'fallen-leaves': 13, 'dirt': 14, 'cobblestone': 15, 'bricks': 16,
    'clovers': 17, 'sandy-beach': 18
};

// Flat fill colors keyed by terrain numeric ID
const TERRAIN_COLORS = {
     0: '#99b53a',  1: '#8e8f8d',  2: '#d7d4d1',  3: '#61aeff',
     4: '#e8e2db',  5: '#eca966',  6: '#cdcfca',  7: '#fcdbe7',
     8: '#e2eff7',  9: '#fab83d', 10: '#f5cc8e', 11: '#98d5ca',
    12: '#ffda38', 13: '#fe8d2b', 14: '#f5d777', 15: '#bbbfc3',
    16: '#f5733e', 17: '#cce460', 18: '#ffdf9e'
};

// Active map preset key
let currentPreset = '118x78';
// 2D array of terrain IDs; path tiles use ID + 100
let grid = [];
let showGrid = true;

// Controls which sidebar panel and interaction rules are active
let currentMode    = 'terrain';   // 'terrain' | 'building' | 'select'
let currentSubMode = 'normal';    // 'normal'  | 'path'

let currentTerrain = 'grass';

let brushShape  = 'square';
let brushWidth  = 1;
let brushHeight = 1;

// Active drawing tool within terrain mode
let activeTool   = 'brush';       // 'brush' | 'bucket' | 'outline'
let outlineStyle = 'thin';        // 'thin'  | 'thick'

// All placed building objects; selectedBuildings holds the active selection subset
let buildings         = [];
let selectedBuildings = [];

// Controls cursor-following behavior during move operations
let activeToolMode    = 'none';   // 'none' | 'move' | 'group-move'
let groupMoveOffsets  = [];       // Per-building delta from cursor center during group-move

let buildingWidth  = 1;
let buildingHeight = 1;
let buildingName   = '';
let buildingColor  = '#3a86ff';

// Multi-select marquee state
let isMultiSelectEnabled = false;
let marqueeStart         = { x: 0, y: 0 };
let isDrawingMarquee     = false;
let marqueeRect          = { x: 0, y: 0, w: 0, h: 0 };

// Holds the floating context-action DOM node for a selected building
let activeContextContainer = null;
let activeTooltipElement   = null;

// World-space camera transform applied to the canvas context
let camera = {
    x: 0, y: 0, zoom: 1.0,
    minZoom: 0.15, maxZoom: 4.0
};

let isDragging  = false;
let isPainting  = false;
let startPanX   = 0;
let startPanY   = 0;

// Current tile under the cursor; -1 means off-map
let hoverTile = { col: -1, row: -1, exactX: -1, exactY: -1 };

const canvas    = document.getElementById('island-canvas');
const ctx       = canvas.getContext('2d');
const workspace = document.getElementById('workspace');

workspace.addEventListener('contextmenu', e => e.preventDefault());

function generateUUID() {
    return Math.random().toString(36).substr(2, 9);
}

// ── UNDO / REDO ─────────────────────────────────────────────────────────────

// Every entry is { execute(), undo() }; redoStack is cleared on new action
let undoStack            = [];
let redoStack            = [];
// Accumulates per-tile deltas during a brush drag; committed as one command on mouseup
let currentStrokeDeltas  = [];

function pushCommand(executeFn, undoFn, applyNow = false) {
    if (applyNow) executeFn();
    undoStack.push({ execute: executeFn, undo: undoFn });
    redoStack = [];
}

function handleUndo() {
    if (undoStack.length === 0) return;
    const cmd = undoStack.pop();
    cmd.undo();
    redoStack.push(cmd);
    clearSelection();
}

function handleRedo() {
    if (redoStack.length === 0) return;
    const cmd = redoStack.pop();
    cmd.execute();
    undoStack.push(cmd);
    clearSelection();
}

// ── SPATIAL HELPERS ──────────────────────────────────────────────────────────

// Returns the topmost building whose tile footprint contains (col, row), or null
function getBuildingAt(col, row) {
    for (let i = buildings.length - 1; i >= 0; i--) {
        const b = buildings[i];
        if (col >= b.col && col < b.col + b.w && row >= b.row && row < b.row + b.h) {
            return b;
        }
    }
    return null;
}

// Resets selection state and removes any floating UI tied to a selection
function clearSelection() {
    selectedBuildings = [];
    activeToolMode    = 'none';
    groupMoveOffsets  = [];
    removeContextUI();
    const groupRow = document.getElementById('group-actions-row');
    if (groupRow) groupRow.classList.add('hidden');
}

function removeContextUI() {
    if (activeContextContainer) {
        activeContextContainer.remove();
        activeContextContainer = null;
    }
}

// Converts a pointer event into tile coords and raw world/view coords
function getCanvasRelativeCoords(e) {
    const rect    = workspace.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const viewX  = clientX - rect.left;
    const viewY  = clientY - rect.top;
    const worldX = (viewX - camera.x) / camera.zoom;
    const worldY = (viewY - camera.y) / camera.zoom;

    return {
        col: Math.floor(worldX / TILE_SIZE),
        row: Math.floor(worldY / TILE_SIZE),
        worldX, worldY, viewX, viewY
    };
}

// ── MAP INITIALIZATION ────────────────────────────────────────────────────────

function initializeMap(presetKey) {
    currentPreset = presetKey;
    const { cols, rows } = MAP_PRESETS[presetKey];

    // Fill grid with terrain ID 0 (grass)
    grid = [];
    for (let r = 0; r < rows; r++) {
        let rowArray = [];
        for (let c = 0; c < cols; c++) rowArray.push(0);
        grid.push(rowArray);
    }

    buildings  = [];
    undoStack  = [];
    redoStack  = [];
    clearSelection();
    resizeCanvasDisplay();
    centerCamera();
}

function resizeCanvasDisplay() {
    canvas.width  = workspace.clientWidth;
    canvas.height = workspace.clientHeight;
    ctx.imageSmoothingEnabled = false;
}

// Centers the map in the current viewport at the current zoom level
function centerCamera() {
    const { cols, rows } = MAP_PRESETS[currentPreset];
    camera.x = (canvas.width  / 2) - (cols * TILE_SIZE * camera.zoom / 2);
    camera.y = (canvas.height / 2) - (rows * TILE_SIZE * camera.zoom / 2);
}

// ── WORKSPACE MOUSE / TOUCH EVENTS ───────────────────────────────────────────

workspace.addEventListener('mousedown', (e) => {
    const coords = getCanvasRelativeCoords(e);

    // Right-click initiates camera pan
    if (e.button === 2) {
        isDragging = true;
        startPanX  = e.clientX - camera.x;
        startPanY  = e.clientY - camera.y;
        return;
    }

    if (e.button === 0) {
        if (currentMode === 'terrain') {
            isPainting          = true;
            currentStrokeDeltas = [];
            applyPaint();

        } else if (currentMode === 'building') {
            // Center the building footprint on the clicked tile
            const startCol = coords.col - Math.floor((buildingWidth  - 1) / 2);
            const startRow = coords.row - Math.floor((buildingHeight - 1) / 2);

            const newBuilding = {
                id:       generateUUID(),
                col:      startCol,
                row:      startRow,
                w:        parseInt(buildingWidth),
                h:        parseInt(buildingHeight),
                name:     buildingName,
                color:    buildingColor,
                rotation: 0
            };

            const buildingToAdd = newBuilding;
            pushCommand(
                () => { buildings.push(buildingToAdd); },
                () => { buildings.splice(buildings.indexOf(buildingToAdd), 1); },
                true
            );

        } else if (currentMode === 'select') {
            // Commit a pending single-building move on click-drop
            if (activeToolMode === 'move' && selectedBuildings.length === 1) {
                const b = selectedBuildings[0];
                const newCol  = b.col,  newRow  = b.row;
                const prevCol = b._moveOriginCol, prevRow = b._moveOriginRow;
                pushCommand(
                    () => { b.col = newCol;  b.row = newRow;  },
                    () => { b.col = prevCol; b.row = prevRow; }
                );
                delete b._moveOriginCol; delete b._moveOriginRow;
                activeToolMode = 'none';
                renderContextActionButtons();
                return;
            }

            // Commit a pending group-move on click-drop
            if (activeToolMode === 'group-move' && selectedBuildings.length > 1) {
                const snapshots = selectedBuildings.map(b => ({
                    b, newCol: b.col, newRow: b.row,
                    prevCol: b._moveOriginCol, prevRow: b._moveOriginRow
                }));
                pushCommand(
                    () => snapshots.forEach(s => { s.b.col = s.newCol;  s.b.row = s.newRow;  }),
                    () => snapshots.forEach(s => { s.b.col = s.prevCol; s.b.row = s.prevRow; })
                );
                selectedBuildings.forEach(b => { delete b._moveOriginCol; delete b._moveOriginRow; });
                activeToolMode = 'none';
                const groupRow = document.getElementById('group-actions-row');
                if (groupRow) groupRow.classList.remove('hidden');
                return;
            }

            if (isMultiSelectEnabled) {
                // Begin marquee drag
                isDrawingMarquee  = true;
                marqueeStart.x    = coords.viewX;
                marqueeStart.y    = coords.viewY;
                marqueeRect       = { x: coords.viewX, y: coords.viewY, w: 0, h: 0 };
                clearSelection();
            } else {
                const clickedBuilding = getBuildingAt(coords.col, coords.row);
                if (clickedBuilding) {
                    selectedBuildings = [clickedBuilding];
                    renderContextActionButtons();
                } else {
                    clearSelection();
                }
            }
        }
    }
});

window.addEventListener('mousemove', (e) => {
    const coords = getCanvasRelativeCoords(e);
    const { cols, rows } = MAP_PRESETS[currentPreset];

    // Update hoverTile; invalidate when cursor leaves the map bounds
    if (coords.col >= 0 && coords.col < cols && coords.row >= 0 && coords.row < rows) {
        hoverTile.exactX = coords.worldX / TILE_SIZE;
        hoverTile.exactY = coords.worldY / TILE_SIZE;
        hoverTile.col    = coords.col;
        hoverTile.row    = coords.row;
    } else {
        hoverTile.col = hoverTile.row = hoverTile.exactX = hoverTile.exactY = -1;
    }

    // Show building name tooltip while hovering and not mid-move
    const hoverTarget = getBuildingAt(coords.col, coords.row);
    if (hoverTarget && hoverTarget.name && activeToolMode === 'none') {
        showTooltip(e, hoverTarget.name);
    } else {
        hideTooltip();
    }

    if (isDragging) {
        camera.x = e.clientX - startPanX;
        camera.y = e.clientY - startPanY;

    } else if (isPainting && currentMode === 'terrain' && activeTool !== 'bucket') {
        applyPaint();

    } else if (isDrawingMarquee) {
        marqueeRect.w = coords.viewX - marqueeStart.x;
        marqueeRect.h = coords.viewY - marqueeStart.y;
        updateMarqueeVisualElement();

    } else if (currentMode === 'select' && hoverTile.col !== -1) {
        // Drag a single building to follow the cursor
        if (activeToolMode === 'move' && selectedBuildings.length === 1) {
            const b = selectedBuildings[0];
            b.col = hoverTile.col - Math.floor((b.w - 1) / 2);
            b.row = hoverTile.row - Math.floor((b.h - 1) / 2);
        }
        // Drag the entire group using pre-computed offsets
        else if (activeToolMode === 'group-move' && selectedBuildings.length > 1 && groupMoveOffsets.length === selectedBuildings.length) {
            selectedBuildings.forEach((b, i) => {
                b.col = hoverTile.col + groupMoveOffsets[i].dCol;
                b.row = hoverTile.row + groupMoveOffsets[i].dRow;
            });
        }
    }
});

window.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
        isPainting = false;

        // Commit the entire brush stroke as a single undoable entry
        if (currentStrokeDeltas.length > 0) {
            const deltas = currentStrokeDeltas.slice();
            pushCommand(
                () => deltas.forEach(d => { grid[d.row][d.col] = d.newId; }),
                () => deltas.forEach(d => { grid[d.row][d.col] = d.oldId; })
            );
            currentStrokeDeltas = [];
        }

        if (isDrawingMarquee) {
            isDrawingMarquee = false;
            processBoxSelection();
            removeMarqueeElement();
        }
    }
    if (e.button === 2) isDragging = false;
});

// Zoom centered on the cursor position
workspace.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect  = workspace.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const mapX = (mouseX - camera.x) / camera.zoom;
    const mapY = (mouseY - camera.y) / camera.zoom;

    const zoomIntensity = 0.05;
    let nextZoom = camera.zoom + (e.deltaY < 0 ? camera.zoom * zoomIntensity : -camera.zoom * zoomIntensity);
    camera.zoom  = Math.max(camera.minZoom, Math.min(camera.maxZoom, nextZoom));
    camera.x     = mouseX - mapX * camera.zoom;
    camera.y     = mouseY - mapY * camera.zoom;
}, { passive: false });

// ── CONTEXT ACTION BUTTONS (rotate / move / recolor) ─────────────────────────

// Injects a floating button row above the selected building in screen space
function renderContextActionButtons() {
    removeContextUI();
    if (selectedBuildings.length !== 1 || activeToolMode === 'move') return;

    const b = selectedBuildings[0];

    // Position above the horizontal center of the building
    const screenX = (b.col * TILE_SIZE + (b.w * TILE_SIZE) / 2) * camera.zoom + camera.x;
    const screenY = (b.row * TILE_SIZE) * camera.zoom + camera.y;

    const container = document.createElement('div');
    container.className    = 'context-actions-container';
    container.style.cssText = `position:absolute;left:${screenX}px;top:${screenY - 15}px;transform:translate(-50%,-100%);z-index:1000;`;

    // Prevent clicks on the button row from propagating to the canvas
    container.addEventListener('mousedown', e => e.stopPropagation());
    container.addEventListener('click',     e => e.stopPropagation());

    // Rotate 90° — swaps width/height and increments rotation metadata
    const rotateBtn = document.createElement('button');
    rotateBtn.className = 'action-ring-btn';
    rotateBtn.innerHTML = '↻';
    rotateBtn.title     = 'Rotate 90°';
    rotateBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const prevW = b.w, prevH = b.h, prevRot = b.rotation;
        const newW  = b.h, newH  = b.w, newRot  = (b.rotation + 90) % 360;
        pushCommand(
            () => { b.w = newW; b.h = newH; b.rotation = newRot; },
            () => { b.w = prevW; b.h = prevH; b.rotation = prevRot; },
            true
        );
        renderContextActionButtons();
    });

    // Attach building to cursor for free placement
    const moveBtn = document.createElement('button');
    moveBtn.className = 'action-ring-btn';
    moveBtn.innerHTML = '✥';
    moveBtn.title     = 'Move Structure';
    moveBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        b._moveOriginCol = b.col;
        b._moveOriginRow = b.row;
        activeToolMode   = 'move';
        removeContextUI();
    });

    // Opens native color picker; change is recorded as an undoable command
    const colorBtn = document.createElement('button');
    colorBtn.className = 'action-ring-btn';
    colorBtn.innerHTML = '🎨';
    colorBtn.title     = 'Recolor Building';
    colorBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();

        let oldPicker = document.getElementById('context-color-picker');
        if (oldPicker) oldPicker.remove();

        const colorPicker        = document.createElement('input');
        colorPicker.id           = 'context-color-picker';
        colorPicker.type         = 'color';
        colorPicker.value        = b.color;
        colorPicker.style.cssText = 'position:absolute;opacity:0;pointer-events:none;';
        document.body.appendChild(colorPicker);

        const originalColor = b.color;

        // Live preview while dragging the picker
        colorPicker.addEventListener('input',  evt => { b.color = evt.target.value; });
        colorPicker.addEventListener('change', evt => {
            const finalColor = evt.target.value;
            pushCommand(
                () => { b.color = finalColor;    },
                () => { b.color = originalColor; }
            );
            b.color = finalColor;
            colorPicker.remove();
        });

        colorPicker.click();
    });

    container.appendChild(rotateBtn);
    container.appendChild(moveBtn);
    container.appendChild(colorBtn);
    workspace.appendChild(container);
    activeContextContainer = container;
}

// ── MARQUEE / BOX SELECTION ───────────────────────────────────────────────────

// Keeps the marquee div in sync with the current drag rectangle
function updateMarqueeVisualElement() {
    let el = document.getElementById('active-marquee');
    if (!el) {
        el = document.createElement('div');
        el.id        = 'active-marquee';
        el.className = 'selection-marquee';
        workspace.appendChild(el);
    }
    const x = marqueeRect.w < 0 ? marqueeStart.x + marqueeRect.w : marqueeStart.x;
    const y = marqueeRect.h < 0 ? marqueeStart.y + marqueeRect.h : marqueeStart.y;
    el.style.left   = `${x}px`;
    el.style.top    = `${y}px`;
    el.style.width  = `${Math.abs(marqueeRect.w)}px`;
    el.style.height = `${Math.abs(marqueeRect.h)}px`;
}

function removeMarqueeElement() {
    const el = document.getElementById('active-marquee');
    if (el) el.remove();
}

// Selects every building whose screen rect intersects the drawn marquee
function processBoxSelection() {
    selectedBuildings = [];
    const viewLeft   = marqueeRect.w < 0 ? marqueeStart.x + marqueeRect.w : marqueeStart.x;
    const viewTop    = marqueeRect.h < 0 ? marqueeStart.y + marqueeRect.h : marqueeStart.y;
    const viewRight  = viewLeft + Math.abs(marqueeRect.w);
    const viewBottom = viewTop  + Math.abs(marqueeRect.h);

    buildings.forEach(b => {
        const bLeft   = (b.col * TILE_SIZE)             * camera.zoom + camera.x;
        const bTop    = (b.row * TILE_SIZE)             * camera.zoom + camera.y;
        const bRight  = bLeft + (b.w * TILE_SIZE)       * camera.zoom;
        const bBottom = bTop  + (b.h * TILE_SIZE)       * camera.zoom;

        if (bLeft < viewRight && bRight > viewLeft && bTop < viewBottom && bBottom > viewTop) {
            selectedBuildings.push(b);
        }
    });

    const groupRow = document.getElementById('group-actions-row');
    if (selectedBuildings.length > 1) {
        if (groupRow) groupRow.classList.remove('hidden');
    } else if (selectedBuildings.length === 1) {
        if (groupRow) groupRow.classList.add('hidden');
        renderContextActionButtons();
    }
}

function showTooltip(e, name) {
    if (!activeTooltipElement) {
        activeTooltipElement           = document.createElement('div');
        activeTooltipElement.className = 'building-tooltip';
        document.body.appendChild(activeTooltipElement);
    }
    activeTooltipElement.innerText    = name;
    activeTooltipElement.style.left   = `${e.clientX + 12}px`;
    activeTooltipElement.style.top    = `${e.clientY + 12}px`;
}

function hideTooltip() {
    if (activeTooltipElement) {
        activeTooltipElement.remove();
        activeTooltipElement = null;
    }
}

// ── TERRAIN BRUSH & FLOOD FILL ────────────────────────────────────────────────

// Draws grid lines; center axes are darkened for orientation reference
function drawGrid() {
    if (!showGrid) return;
    const { cols, rows } = MAP_PRESETS[currentPreset];
    const midX = Math.floor(cols / 2);
    const midY = Math.floor(rows / 2);

    for (let c = 0; c <= cols; c++) {
        ctx.beginPath();
        ctx.strokeStyle = c === midX ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.15)';
        ctx.lineWidth   = c === midX ? 2 : 1;
        ctx.moveTo(c * TILE_SIZE, 0);
        ctx.lineTo(c * TILE_SIZE, rows * TILE_SIZE);
        ctx.stroke();
    }
    for (let r = 0; r <= rows; r++) {
        ctx.beginPath();
        ctx.strokeStyle = r === midY ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.15)';
        ctx.lineWidth   = r === midY ? 2 : 1;
        ctx.moveTo(0, r * TILE_SIZE);
        ctx.lineTo(cols * TILE_SIZE, r * TILE_SIZE);
        ctx.stroke();
    }
}

// Returns the set of tiles covered by the current brush centered on hoverTile
function getTilesInBrush() {
    const tiles = [];
    if (hoverTile.col === -1) return tiles;

    const { cols, rows } = MAP_PRESETS[currentPreset];

    // Even-size brushes snap to the nearest tile edge rather than tile center
    let brushCenterX, brushCenterY;
    if (brushWidth % 2 === 0) {
        const tileBaseX = Math.floor(hoverTile.exactX);
        brushCenterX    = tileBaseX + (hoverTile.exactX - tileBaseX < 0.5 ? 0 : 1);
    } else {
        brushCenterX = Math.floor(hoverTile.exactX) + 0.5;
    }
    if (brushHeight % 2 === 0) {
        const tileBaseY = Math.floor(hoverTile.exactY);
        brushCenterY    = tileBaseY + (hoverTile.exactY - tileBaseY < 0.5 ? 0 : 1);
    } else {
        brushCenterY = Math.floor(hoverTile.exactY) + 0.5;
    }

    const radiusX = brushWidth  / 2;
    const radiusY = brushHeight / 2;
    const startCol = Math.floor(brushCenterX - radiusX);
    const startRow = Math.floor(brushCenterY - radiusY);
    const endCol   = startCol + brushWidth  - 1;
    const endRow   = startRow + brushHeight - 1;

    for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
            if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
            if (brushShape === 'square') {
                tiles.push({ col: c, row: r });
            } else if (brushShape === 'circle') {
                const dx = (c + 0.5) - brushCenterX;
                const dy = (r + 0.5) - brushCenterY;
                if ((dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) <= 1.0001) {
                    tiles.push({ col: c, row: r });
                }
            }
        }
    }
    return tiles;
}

// Filters the full brush set to only perimeter tiles, respecting outline style
function getOutlineTiles() {
    const fullBrushTiles = getTilesInBrush();
    if (fullBrushTiles.length === 0) return [];

    const keyMap      = new Set(fullBrushTiles.map(t => `${t.col},${t.row}`));
    const outlineTiles = [];

    fullBrushTiles.forEach(tile => {
        const hasUp    = keyMap.has(`${tile.col},${tile.row - 1}`);
        const hasDown  = keyMap.has(`${tile.col},${tile.row + 1}`);
        const hasLeft  = keyMap.has(`${tile.col - 1},${tile.row}`);
        const hasRight = keyMap.has(`${tile.col + 1},${tile.row}`);
        const isCardinalEdge = (!hasUp || !hasDown || !hasLeft || !hasRight);

        if (outlineStyle === 'thin') {
            if (isCardinalEdge) outlineTiles.push(tile);
        } else if (outlineStyle === 'thick') {
            // Thick mode also captures diagonal-only neighbours (inner corners)
            const hasUpLeft    = keyMap.has(`${tile.col - 1},${tile.row - 1}`);
            const hasUpRight   = keyMap.has(`${tile.col + 1},${tile.row - 1}`);
            const hasDownLeft  = keyMap.has(`${tile.col - 1},${tile.row + 1}`);
            const hasDownRight = keyMap.has(`${tile.col + 1},${tile.row + 1}`);
            if (isCardinalEdge || !hasUpLeft || !hasUpRight || !hasDownLeft || !hasDownRight) {
                outlineTiles.push(tile);
            }
        }
    });
    return outlineTiles;
}

// Writes terrain IDs into the grid for the current tool and records deltas
function applyPaint() {
    if (currentMode !== 'terrain' || hoverTile.col === -1) return;
    if (activeTool === 'bucket') { applyFloodFill(hoverTile.col, hoverTile.row); return; }

    const activeTiles    = activeTool === 'outline' ? getOutlineTiles() : getTilesInBrush();
    const baseTerrainID  = TERRAIN_TYPES[currentTerrain];
    // Path tiles are stored as base ID + 100 to distinguish them from base terrain
    const targetTerrainID = currentSubMode === 'path' ? baseTerrainID + 100 : baseTerrainID;

    activeTiles.forEach(tile => {
        const oldId = grid[tile.row][tile.col];
        if (oldId !== targetTerrainID) {
            if (!currentStrokeDeltas.some(d => d.row === tile.row && d.col === tile.col)) {
                currentStrokeDeltas.push({ row: tile.row, col: tile.col, oldId, newId: targetTerrainID });
            }
            grid[tile.row][tile.col] = targetTerrainID;
        }
    });
}

// BFS flood fill replacing matching terrain from the seed tile outward
function applyFloodFill(startCol, startRow) {
    const { cols, rows } = MAP_PRESETS[currentPreset];
    const targetColorID      = grid[startRow][startCol];
    const replacementColorID = TERRAIN_TYPES[currentTerrain];
    const targetTerrainID    = currentSubMode === 'path' ? replacementColorID + 100 : replacementColorID;

    if (targetColorID === targetTerrainID) return;

    let queue      = [{ c: startCol, r: startRow }];
    let fillDeltas = [];

    while (queue.length > 0) {
        const cell = queue.shift();
        if (cell.c >= 0 && cell.c < cols && cell.r >= 0 && cell.r < rows) {
            if (grid[cell.r][cell.c] === targetColorID) {
                fillDeltas.push({ row: cell.r, col: cell.c, oldId: targetColorID, newId: targetTerrainID });
                grid[cell.r][cell.c] = targetTerrainID;
                queue.push({ c: cell.c + 1, r: cell.r });
                queue.push({ c: cell.c - 1, r: cell.r });
                queue.push({ c: cell.c, r: cell.r + 1 });
                queue.push({ c: cell.c, r: cell.r - 1 });
            }
        }
    }

    if (fillDeltas.length > 0) {
        const deltas = fillDeltas;
        pushCommand(
            () => deltas.forEach(d => { grid[d.row][d.col] = d.newId; }),
            () => deltas.forEach(d => { grid[d.row][d.col] = d.oldId; })
        );
    }
}

// Path tiles have IDs ≥ 100; base terrain = ID − 100
function isPathTile(col, row) {
    const { cols, rows } = MAP_PRESETS[currentPreset];
    if (col < 0 || col >= cols || row < 0 || row >= rows) return false;
    return grid[row][col] >= 100;
}

function getCleanTerrainID(tileID) {
    return tileID >= 100 ? tileID - 100 : tileID;
}

// ── RENDER PIPELINE ───────────────────────────────────────────────────────────

function render() {
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    const { cols, rows } = MAP_PRESETS[currentPreset];

    // Default grass fill covers the entire map before per-tile overrides
    ctx.fillStyle = '#99b53a';
    ctx.fillRect(0, 0, cols * TILE_SIZE, rows * TILE_SIZE);

    // Layer 1 — base terrain colors, path dark-tint overlay, and curb dots
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const rawID   = grid[r][c];
            const cleanID = getCleanTerrainID(rawID);

            if (cleanID !== 0) {
                ctx.fillStyle = TERRAIN_COLORS[cleanID] || '#99b53a';
                ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            } else if (rawID >= 100) {
                // Grass path — lay down explicit grass color before tint
                ctx.fillStyle = TERRAIN_COLORS[0];
                ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            }

            // Semi-transparent overlay that darkens every path tile
            if (rawID >= 100) {
                ctx.save();
                ctx.fillStyle = 'rgba(0,0,0,0.18)';
                ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
                ctx.restore();
            }

            // White curb dots at path tile edges and inner corners
            if (rawID >= 100) {
                ctx.save();
                ctx.fillStyle = '#FFFFFF';
                const x = c * TILE_SIZE, y = r * TILE_SIZE, t = 3, s = TILE_SIZE;

                const N  = isPathTile(c, r - 1), S  = isPathTile(c, r + 1);
                const W  = isPathTile(c - 1, r), E  = isPathTile(c + 1, r);
                const NW = isPathTile(c - 1, r - 1), NE = isPathTile(c + 1, r - 1);
                const SW = isPathTile(c - 1, r + 1), SE = isPathTile(c + 1, r + 1);

                if (!N) ctx.fillRect(x,         y,         s, t);
                if (!S) ctx.fillRect(x,         y + s - t, s, t);
                if (!W) ctx.fillRect(x,         y,         t, s);
                if (!E) ctx.fillRect(x + s - t, y,         t, s);

                if (!N && !W) ctx.fillRect(x,         y,         t, t);
                if (!N && !E) ctx.fillRect(x + s - t, y,         t, t);
                if (!S && !W) ctx.fillRect(x,         y,         t, t);
                if (!S && !E) ctx.fillRect(x + s - t, y + s - t, t, t);

                // Inner-corner curb dots where two orthogonal path tiles meet
                if (N && W && !NW) ctx.fillRect(x,         y,         t, t);
                if (N && E && !NE) ctx.fillRect(x + s - t, y,         t, t);
                if (S && W && !SW) ctx.fillRect(x,         y + s - t, t, t);
                if (S && E && !SE) ctx.fillRect(x + s - t, y + s - t, t, t);

                ctx.restore();
            }
        }
    }

    // Layer 2 — ghost preview of building placement at cursor
    if (currentMode === 'building' && hoverTile.col !== -1) {
        ctx.save();
        const startCol = hoverTile.col - Math.floor((buildingWidth  - 1) / 2);
        const startRow = hoverTile.row - Math.floor((buildingHeight - 1) / 2);
        ctx.fillStyle    = buildingColor;
        ctx.globalAlpha  = 0.5;
        ctx.fillRect(startCol * TILE_SIZE, startRow * TILE_SIZE, buildingWidth * TILE_SIZE, buildingHeight * TILE_SIZE);
        ctx.restore();
    }

    // Layer 3 — placed buildings with label text and selection outline
    buildings.forEach(b => {
        ctx.save();
        const bx = b.col * TILE_SIZE, by = b.row * TILE_SIZE;
        const bw = b.w   * TILE_SIZE, bh = b.h   * TILE_SIZE;

        ctx.fillStyle = b.color;
        ctx.fillRect(bx, by, bw, bh);

        // Selected buildings get a dashed pink stroke; others get a subtle border
        if (selectedBuildings.includes(b)) {
            ctx.strokeStyle = '#ff007f';
            ctx.lineWidth   = 2;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(bx, by, bw, bh);
            ctx.setLineDash([]);
        } else {
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.lineWidth   = 1;
            ctx.strokeRect(bx, by, bw, bh);
        }

        // Auto-sized centered label; font scales with building area
        if (b.name) {
            ctx.fillStyle      = '#FFFFFF';
            ctx.textAlign      = 'center';
            ctx.textBaseline   = 'middle';
            const calcFontSize = Math.min(Math.max((bw / b.name.length) * 0.8, 10), 48);
            ctx.font           = `bold ${calcFontSize}px sans-serif`;
            ctx.shadowColor    = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur     = 4;
            ctx.fillText(b.name, bx + bw / 2, by + bh / 2);
        }
        ctx.restore();
    });

    // Layer 4 — grid line overlay
    drawGrid();

    // Layer 5 — brush highlight using difference blend so it reads on any terrain
    if (hoverTile.col !== -1 && !isDragging && currentMode === 'terrain') {
        const activeBrushTiles = activeTool === 'bucket'  ? [{ col: hoverTile.col, row: hoverTile.row }]
                               : activeTool === 'outline' ? getOutlineTiles()
                               : getTilesInBrush();
        ctx.save();
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = 'rgba(0,128,255,0.4)';
        activeBrushTiles.forEach(tile => {
            ctx.fillRect(tile.col * TILE_SIZE, tile.row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        });
        ctx.restore();
    }

    ctx.restore();
    requestAnimationFrame(render);
}

// ── SIDEBAR BINDINGS ──────────────────────────────────────────────────────────

document.getElementById('map-size').addEventListener('change', e => initializeMap(e.target.value));
document.getElementById('btn-center').addEventListener('click', centerCamera);
window.addEventListener('resize', () => { resizeCanvasDisplay(); centerCamera(); });
document.getElementById('toggle-grid').addEventListener('change', e => { showGrid = e.target.checked; });

// Switches the active mode, activates the matching tab button, and shows the matching sub-panel
function switchEditorMode(newMode) {
    currentMode = newMode;
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.sub-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById(`mode-${newMode}`).classList.add('active');
    document.getElementById(`panel-${newMode}`).classList.remove('hidden');
    clearSelection();
}

document.getElementById('mode-terrain').addEventListener('click',   () => switchEditorMode('terrain'));
document.getElementById('mode-building').addEventListener('click',  () => switchEditorMode('building'));
document.getElementById('mode-select').addEventListener('click',    () => switchEditorMode('select'));

document.getElementById('sub-terrain-normal').addEventListener('click', (e) => {
    currentSubMode = 'normal';
    document.getElementById('sub-terrain-path').classList.remove('active');
    e.target.classList.add('active');
});
document.getElementById('sub-terrain-path').addEventListener('click', (e) => {
    currentSubMode = 'path';
    document.getElementById('sub-terrain-normal').classList.remove('active');
    e.target.classList.add('active');
});

document.getElementById('terrain-type').addEventListener('change', e => { currentTerrain = e.target.value; });

document.getElementById('brush-shape-square').addEventListener('click', (e) => {
    brushShape = 'square';
    document.getElementById('brush-shape-circle').classList.remove('active');
    e.target.classList.add('active');
});
document.getElementById('brush-shape-circle').addEventListener('click', (e) => {
    brushShape = 'circle';
    document.getElementById('brush-shape-square').classList.remove('active');
    e.target.classList.add('active');
});

document.getElementById('brush-width').addEventListener('input',  e => { const v = parseInt(e.target.value); brushWidth  = isNaN(v) || v < 1 ? 1 : v; });
document.getElementById('brush-height').addEventListener('input', e => { const v = parseInt(e.target.value); brushHeight = isNaN(v) || v < 1 ? 1 : v; });

document.getElementById('building-name').addEventListener('input',  e => { buildingName   = e.target.value; });
document.getElementById('build-width').addEventListener('input',    e => { buildingWidth  = Math.max(1, parseInt(e.target.value) || 1); });
document.getElementById('build-height').addEventListener('input',   e => { buildingHeight = Math.max(1, parseInt(e.target.value) || 1); });
document.getElementById('building-color').addEventListener('input', e => { buildingColor  = e.target.value; });
document.getElementById('toggle-multi-select').addEventListener('change', e => { isMultiSelectEnabled = e.target.checked; clearSelection(); });

// Rotates the entire group around its collective bounding-box center
document.getElementById('btn-group-rotate').addEventListener('click', () => {
    if (selectedBuildings.length <= 1) return;

    let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    selectedBuildings.forEach(b => {
        if (b.col < minCol)       minCol = b.col;
        if (b.col + b.w > maxCol) maxCol = b.col + b.w;
        if (b.row < minRow)       minRow = b.row;
        if (b.row + b.h > maxRow) maxRow = b.row + b.h;
    });

    const centerCol = (minCol + maxCol) / 2;
    const centerRow = (minRow + maxRow) / 2;

    const snapshots = selectedBuildings.map(b => ({
        b,
        prevCol: b.col, prevRow: b.row,
        prevW:   b.w,   prevH:   b.h,   prevRot: b.rotation
    }));

    const doRotate = () => {
        snapshots.forEach(({ b }) => {
            const relativeCol = (b.col + b.w / 2) - centerCol;
            const relativeRow = (b.row + b.h / 2) - centerRow;
            const oldW = b.w;
            b.w        = b.h; b.h = oldW;
            b.rotation = (b.rotation + 90) % 360;
            b.col      = Math.round(centerCol + (-relativeRow) - b.w / 2);
            b.row      = Math.round(centerRow + relativeCol    - b.h / 2);
        });
    };

    const doUnrotate = () => {
        snapshots.forEach(({ b, prevCol, prevRow, prevW, prevH, prevRot }) => {
            b.col = prevCol; b.row = prevRow;
            b.w   = prevW;   b.h   = prevH;   b.rotation = prevRot;
        });
    };

    pushCommand(doRotate, doUnrotate, true);
});

// Computes per-building cursor offsets then enters group-move mode
document.getElementById('btn-group-move').addEventListener('click', () => {
    if (selectedBuildings.length <= 1) return;

    let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    selectedBuildings.forEach(b => {
        if (b.col < minCol)       minCol = b.col;
        if (b.col + b.w > maxCol) maxCol = b.col + b.w;
        if (b.row < minRow)       minRow = b.row;
        if (b.row + b.h > maxRow) maxRow = b.row + b.h;
    });

    const medianCol = Math.floor((minCol + maxCol) / 2);
    const medianRow = Math.floor((minRow + maxRow) / 2);

    groupMoveOffsets = selectedBuildings.map(b => ({
        dCol: b.col - medianCol,
        dRow: b.row - medianRow
    }));

    selectedBuildings.forEach(b => {
        b._moveOriginCol = b.col;
        b._moveOriginRow = b.row;
    });

    activeToolMode = 'group-move';
    const groupRow = document.getElementById('group-actions-row');
    if (groupRow) groupRow.classList.add('hidden');
});

// Clear map confirmation modal
const clearModal = document.getElementById('clear-modal');
document.getElementById('btn-clear-map').addEventListener('click', () => { clearModal.classList.remove('hidden'); });
document.getElementById('modal-no').addEventListener('click',       () => { clearModal.classList.add('hidden');    });
document.getElementById('modal-yes').addEventListener('click', () => {
    const prevGrid      = grid.map(row => row.slice());
    const prevBuildings = JSON.parse(JSON.stringify(buildings));

    pushCommand(
        () => { grid.forEach(row => row.fill(0)); buildings.length = 0; clearSelection(); },
        () => {
            prevGrid.forEach((row, r) => row.forEach((val, c) => { grid[r][c] = val; }));
            buildings.length = 0;
            prevBuildings.forEach(b => buildings.push(b));
            clearSelection();
        },
        true
    );

    // Clear wipes history — no undo past this point
    undoStack = []; redoStack = [];
    clearModal.classList.add('hidden');
});

// Deactivates all tool buttons then re-activates the chosen one
function resetToolButtons() {
    document.getElementById('tool-brush').classList.remove('active');
    document.getElementById('tool-bucket').classList.remove('active');
    document.getElementById('tool-outline').classList.remove('active');
}

const brushSettingsGroup  = document.getElementById('brush-settings-group');
const outlineThicknessRow = document.getElementById('outline-thickness-row');

// Brush — shows size controls, hides outline style row
document.getElementById('tool-brush').addEventListener('click', (e) => {
    activeTool = 'brush'; resetToolButtons(); e.target.classList.add('active');
    brushSettingsGroup.classList.remove('hidden'); outlineThicknessRow.classList.add('hidden');
});
// Bucket — hides both brush and outline controls
document.getElementById('tool-bucket').addEventListener('click', (e) => {
    activeTool = 'bucket'; resetToolButtons(); e.target.classList.add('active');
    brushSettingsGroup.classList.add('hidden'); outlineThicknessRow.classList.add('hidden');
});
// Outline — shows both brush size controls and outline style selector
document.getElementById('tool-outline').addEventListener('click', (e) => {
    activeTool = 'outline'; resetToolButtons(); e.target.classList.add('active');
    brushSettingsGroup.classList.remove('hidden'); outlineThicknessRow.classList.remove('hidden');
});

document.getElementById('outline-thin').addEventListener('click', (e) => {
    outlineStyle = 'thin';
    document.getElementById('outline-thick').classList.remove('active');
    e.target.classList.add('active');
});
document.getElementById('outline-thick').addEventListener('click', (e) => {
    outlineStyle = 'thick';
    document.getElementById('outline-thin').classList.remove('active');
    e.target.classList.add('active');
});

document.getElementById('btn-undo').addEventListener('click', handleUndo);
document.getElementById('btn-redo').addEventListener('click', handleRedo);

// Keyboard shortcuts for undo / redo
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); handleUndo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); handleRedo(); }
});

// ── SAVE / LOAD ───────────────────────────────────────────────────────────────
function exportIsland() {
    const saveData = {
        version:   '1.0.0',
        mapPreset: currentPreset,
        grid:      grid.map(row => row.slice()),   // deep copy
        buildings: JSON.parse(JSON.stringify(buildings))
    };

    const blob = new Blob([JSON.stringify(saveData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `island-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importIsland(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);

            // Validate the basic shape before touching live state
            if (!data.mapPreset || !MAP_PRESETS[data.mapPreset]) {
                alert('Invalid save file: unknown map preset.');
                return;
            }
            if (!Array.isArray(data.grid) || !Array.isArray(data.buildings)) {
                alert('Invalid save file: missing grid or buildings data.');
                return;
            }

            const { cols, rows } = MAP_PRESETS[data.mapPreset];
            if (data.grid.length !== rows || data.grid[0]?.length !== cols) {
                alert('Save file grid dimensions do not match its declared preset.');
                return;
            }

            // Apply everything at once
            currentPreset = data.mapPreset;
            document.getElementById('map-size').value = currentPreset;

            grid = data.grid.map(row => row.slice());
            buildings.length = 0;
            data.buildings.forEach(b => buildings.push(b));

            undoStack = [];
            redoStack = [];
            clearSelection();
            resizeCanvasDisplay();
            centerCamera();

        } catch (err) {
            alert('Could not read save file. Make sure it is a valid Island Planner JSON.');
            console.error(err);
        }
    };
    reader.readAsText(file);
}

document.getElementById('btn-save-island').addEventListener('click', exportIsland);

document.getElementById('btn-load-island').addEventListener('click', () => {
    document.getElementById('load-file-input').value = '';   // reset so same file can be re-loaded
    document.getElementById('load-file-input').click();
});

document.getElementById('load-file-input').addEventListener('change', (e) => {
    importIsland(e.target.files[0]);
});

initializeMap(currentPreset);
render();