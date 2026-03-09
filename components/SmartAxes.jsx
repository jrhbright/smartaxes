"use client";
import { useState, useEffect, useRef, useMemo } from "react";

const SANS = "'DM Sans', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia', serif"; // kept for SVG graph labels only

// ============================================================
// SMART AXES ALGORITHM
// Core logic: given min/max, calculate optimal axes, ticks, grid
// ============================================================


// SmartAxes v5
const A4_WIDTH_MM = 190; // usable (210 - 20mm margins)
const A4_HEIGHT_MM = 270; // usable (297 - 27mm margins)
const STANDARD_SQUARE_MM = 2; // 2mm per small square
const STD_COLS = Math.floor(A4_WIDTH_MM / STANDARD_SQUARE_MM); // 95
const STD_ROWS = Math.floor(A4_HEIGHT_MM / STANDARD_SQUARE_MM); // 135
const MIN_SQUARES = 0.7; // allow shrinking to 70% of standard
const MAX_SQUARES = 1.25; // allow growing to 125% of standard

function niceNumber(range, round) {
  const exp = Math.floor(Math.log10(range));
  const f = range / Math.pow(10, exp);
  let nf;
  if (round) {
    if (f < 1.5) nf = 1;
    else if (f < 3) nf = 2;
    else if (f < 7) nf = 5;
    else nf = 10;
  } else {
    if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 5) nf = 5;
    else nf = 10;
  }
  return nf * Math.pow(10, exp);
}

function findNiceInterval(range, targetTicks = 8) {
  // Ordered by preference — whole numbers strongly preferred over decimals
  // 2.5 and 0.25 etc are last resorts only when nothing else fits
  const exp = Math.floor(Math.log10(range / targetTicks));
  const magnitude = Math.pow(10, exp);
  const candidates = [
    1, 2, 5, 10, 20, 50, 100, 200, 500,   // whole number multiples
    0.1, 0.2, 0.5,                          // sub-1 whole-ish
    2.5, 25, 250,                           // decimal — only if nothing else fits
    0.25,
  ].map(x => x * magnitude / 10);

  // Score: prefer intervals that give 4-12 ticks, heavily penalise decimals
  let best = candidates[0];
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c <= 0) continue;
    const ticks = Math.ceil(range / c);
    if (ticks < 2) continue; // too few ticks is useless
    const isDecimal = (c * 10) % 10 !== 0; // true if interval has decimal part
    const decimalPenalty = isDecimal ? 1000 : 0;
    const score = Math.abs(ticks - targetTicks) + decimalPenalty;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}

function getMinorDivisions(interval) {
  // Return minor divisions per major interval (prefer 10, then 5, then 2)
  const str = interval.toString();
  if (interval >= 10 && interval % 10 === 0) return { minor: 10, medium: 5 };
  if (interval >= 5 && interval % 5 === 0) return { minor: 10, medium: 5 };
  if (interval === 2 || interval === 20 || interval === 200) return { minor: 10, medium: 5 };
  if (interval === 2.5 || interval === 25 || interval === 250) return { minor: 5, medium: 0 };
  if (interval === 1 || interval === 0.5 || interval === 0.1) return { minor: 10, medium: 5 };
  return { minor: 10, medium: 5 };
}

function calculateAxis(min, max) {
  if (min >= max) max = min + 10;
  const range = max - min;
  const interval = findNiceInterval(range, 8);
  const niceMin = Math.round(Math.floor(min / interval) * interval * 1e10) / 1e10;
  const niceMax = Math.round(Math.ceil(max / interval) * interval * 1e10) / 1e10;
  const { minor, medium } = getMinorDivisions(interval);
  const smallSquaresNeeded = ((niceMax - niceMin) / interval) * minor;
  return { min: niceMin, max: niceMax, interval, minor, medium, smallSquaresNeeded };
}

function smartCalculateAxes(xMin, xMax, yMin, yMax) {
  // Available space in small squares at standard 2mm
  const availXSq = A4_WIDTH_MM  / STANDARD_SQUARE_MM;
  const availYSq = A4_HEIGHT_MM / STANDARD_SQUARE_MM;

  // Generate candidate intervals for an axis range
  function candidateIntervals(range) {
    const exp = Math.floor(Math.log10(range));
    const mag = Math.pow(10, exp - 1);
    return [1, 2, 5, 10, 20, 50, 100, 200, 500, 0.1, 0.2, 0.5]
      .map(x => Math.round(x * mag * 1e10) / 1e10) // round to avoid float noise
      .filter(c => {
        if (c <= 0) return false;
        const ticks = Math.ceil(range / c);
        if (ticks < 2 || ticks > 30) return false;
        // Only allow intervals that are 1, 2, or 5 × a power of 10
        const log = Math.log10(c);
        const exp = Math.floor(log + 1e-9);
        const mantissa = Math.round(c / Math.pow(10, exp) * 10) / 10;
        return [1, 2, 5].includes(mantissa);
      });
  }

  function axisForInterval(min, max, interval) {
    const niceMin = Math.round(Math.floor(min / interval) * interval * 1e10) / 1e10;
    const niceMax = Math.round(Math.ceil(max  / interval) * interval * 1e10) / 1e10;
    const { minor, medium } = getMinorDivisions(interval);
    const smallSquaresNeeded = Math.round(((niceMax - niceMin) / interval) * minor);
    return { min: niceMin, max: niceMax, interval, minor, medium, smallSquaresNeeded };
  }

  const xCandidates = candidateIntervals(xMax - xMin);
  const yCandidates = candidateIntervals(yMax - yMin);

  // Fall back to default if no candidates
  if (!xCandidates.length) xCandidates.push(findNiceInterval(xMax - xMin));
  if (!yCandidates.length) yCandidates.push(findNiceInterval(yMax - yMin));

  // Joint optimisation: find the (xInterval, yInterval) pair that best fills the page
  let bestScore = -1;
  let bestXAxis = axisForInterval(xMin, xMax, xCandidates[0]);
  let bestYAxis = axisForInterval(yMin, yMax, yCandidates[0]);

  for (const xi of xCandidates) {
    for (const yi of yCandidates) {
      const xa = axisForInterval(xMin, xMax, xi);
      const ya = axisForInterval(yMin, yMax, yi);
      if (xa.smallSquaresNeeded > availXSq * 2) continue; // too many squares
      if (ya.smallSquaresNeeded > availYSq * 2) continue;
      // Square size this combo produces (capped at 2.5× standard = 5mm)
      const sqSize = Math.min(availXSq / xa.smallSquaresNeeded, availYSq / ya.smallSquaresNeeded, 2.5);
      const fillX = Math.min(1, (xa.smallSquaresNeeded * sqSize) / availXSq);
      const fillY = Math.min(1, (ya.smallSquaresNeeded * sqSize) / availYSq);
      // The constrained axis (whichever needs more squares relative to space) drives sqSize.
      // Score on that axis's fill. The other axis being less full is fine — don't penalise it.
      const fill = Math.max(fillX, fillY); // constrained axis will be at or near 1.0
      // Prefer square size close to standard (sqSize=1.0)
      const sizePenalty = Math.abs(Math.log(sqSize));
      // Prefer natural major tick counts
      const niceTicks = [2, 4, 5, 6, 7, 8, 10, 12, 13, 20, 25];
      const xTicks = Math.round((xa.max - xa.min) / xa.interval);
      const yTicks = Math.round((ya.max - ya.min) / ya.interval);
      const tickPenalty = (niceTicks.includes(xTicks) ? 0 : 0.08) + (niceTicks.includes(yTicks) ? 0 : 0.08);
      // Penalise too many major ticks — more than 12 starts to look crowded
      const tooManyPenalty = Math.max(0, xTicks - 12) * 0.05 + Math.max(0, yTicks - 12) * 0.05;
      // When squares are larger than standard, reward filling the unconstrained axis too
      const secondaryFill = Math.min(fillX, fillY);
      const secondaryBonus = sqSize > 0.7 ? 0.3 * secondaryFill : 0;
      const score = fill - 0.6 * sizePenalty - tickPenalty - tooManyPenalty + secondaryBonus;
      if (score > bestScore) {
        bestScore = score;
        bestXAxis = xa;
        bestYAxis = ya;
      }
    }
  }

  const squareMM = Math.min(
    A4_WIDTH_MM  / bestXAxis.smallSquaresNeeded,
    A4_HEIGHT_MM / bestYAxis.smallSquaresNeeded
  );
  const clampedMM = Math.max(STANDARD_SQUARE_MM * MIN_SQUARES, Math.min(STANDARD_SQUARE_MM * MAX_SQUARES, squareMM));

  let warnings = [];
  if (squareMM < STANDARD_SQUARE_MM * MIN_SQUARES) {
    warnings.push("Grid squares are very small. Consider a coarser scale or A3 paper.");
  }

  return {
    xAxis: bestXAxis,
    yAxis: bestYAxis,
    squareSizeMM: Math.round(clampedMM * 100) / 100,
    warnings,
    colsAvailable: Math.floor(A4_WIDTH_MM / clampedMM),
    rowsAvailable: Math.floor(A4_HEIGHT_MM / clampedMM),
  };
}

// ============================================================
// FORMAT TICK LABELS
// ============================================================
function formatTick(value, interval) {
  if (Math.abs(value) < 1e-10) return "0";
  // Count decimal places needed based on interval
  const intervalStr = interval.toString();
  const dotIndex = intervalStr.indexOf('.');
  const decimals = dotIndex >= 0 ? intervalStr.length - dotIndex - 1 : 0;
  if (decimals === 0) return value.toFixed(0);
  // Format with required decimals but strip trailing zeros for whole numbers
  const formatted = value.toFixed(decimals);
  return parseFloat(formatted).toString();
}

// ============================================================
// SVG GRAPH RENDERER
// ============================================================
function GraphSVG({ config, width, height }) {
  const {
    xAxis, yAxis, squareSizeMM,
    xLabel, yLabel, xSubLabel, ySubLabel,
    showGrid, gridColor, bw, showMinorGrid, showMediumGrid,
    gridExtend, showWorksheet, instruction,
    showTitle, titleText, titlePosition,
    labelScale, subLabelScale, labelBold, subLabelBold,
    alignH = "auto", alignV = "auto",
  } = config;

  // Derive mm-to-px from actual rendered width (A4 = 210mm wide)
  const MM_TO_PX = width / 210;
  const pageW = width;
  const pageH = height;

  // ── Margin constants (easy to tune) ───────────────────────────
  const LABEL_ORIGIN_MM  = 20;  // 2cm: label space when axis is at grid edge
  const MIN_CLEARANCE_MM = 8;   // 8mm: clearance when axis is inside the grid
  const RIGHT_MARGIN_MM  = 12;  // space for arrow tip + axis letter on right
  const TOP_MARGIN_MM    = 12;  // space for arrow tip + axis letter on top

  const labelOrigin  = LABEL_ORIGIN_MM  * MM_TO_PX;
  const minClearance = MIN_CLEARANCE_MM * MM_TO_PX;
  const rightMargin  = RIGHT_MARGIN_MM  * MM_TO_PX;
  const topMargin    = TOP_MARGIN_MM    * MM_TO_PX;
  const printMargin  = 8 * MM_TO_PX;  // kept only for gridExtend clipping

  // ── Header space ───────────────────────────────────────────────
  const worksheetH  = showWorksheet ? 72 : 0;
  const aboveTitleH = (showTitle && titlePosition === "above") ? 28 : 0;
  const headerH     = worksheetH + aboveTitleH;

  // ── Does the axis sit at the grid edge or inside? ─────────────
  const xNegative = xAxis.min < 0;  // y-axis is inside the grid
  const yNegative = yAxis.min < 0;  // x-axis is inside the grid

  // Left: 2cm from page edge if axis at left, 5mm if axis is inside
  const leftClearance   = xNegative ? minClearance : labelOrigin;
  // Bottom: 2cm from page edge if axis at bottom, 5mm if axis is inside
  const bottomClearance = yNegative ? minClearance : labelOrigin;

  // ── Available space ───────────────────────────────────────────
  const availRight = pageW - rightMargin;
  const availTop   = headerH + topMargin;
  // For sizing purposes, use the full available area
  const availW = availRight - leftClearance;
  const availH = (pageH - bottomClearance) - availTop;

  // ── Fit square size into available space ──────────────────────
  const STD_SQ_PX = 2 * MM_TO_PX;
  const MIN_SQ_PX = STD_SQ_PX * MIN_SQUARES;

  // ── Use minor divisions as calculated by calculateAxis ───────────
  // getMinorDivisions already picks sensible values (10 with medium 5, or 5 for coarse intervals)
  // The page-filling is achieved simply by letting actualSqPx grow uncapped.
  const xMajor = Math.round((xAxis.max - xAxis.min) / xAxis.interval);
  const yMajor = Math.round((yAxis.max - yAxis.min) / yAxis.interval);

  const xAxisF = { ...xAxis };
  const yAxisF = { ...yAxis };

  const xSquares = Math.round(xAxisF.smallSquaresNeeded);
  const ySquares = Math.round(yAxisF.smallSquaresNeeded);
  const MAX_SQ_PX = 5 * MM_TO_PX; // 5mm per small square max — beyond this looks stretched
  const maxSqPx  = Math.min(availW / xSquares, availH / ySquares, MAX_SQ_PX);
  const actualSqPx = Math.max(MIN_SQ_PX, maxSqPx);

  // ── Grid dimensions ───────────────────────────────────────────
  const gridW = xSquares * actualSqPx;
  const gridH = ySquares * actualSqPx;

  // ── Resolve alignment (auto uses axis sign as default) ───────
  const resolvedAlignH = alignH === "auto" ? (xNegative ? "centre" : "left")   : alignH;
  const resolvedAlignV = alignV === "auto" ? (yNegative ? "centre" : "bottom") : alignV;

  // ── Horizontal position ───────────────────────────────────────
  const gridLeft = resolvedAlignH === "left"
    ? leftClearance
    : (leftClearance + availRight) / 2 - gridW / 2;
  const gridRight = gridLeft + gridW;

  // ── Vertical position ─────────────────────────────────────────
  const gridBottom = resolvedAlignV === "bottom"
    ? pageH - bottomClearance
    : availTop + availH / 2 + gridH / 2;
  const gridTop = gridBottom - gridH;

  // Font size: fixed range regardless of square size, scaled by user preference
  // Base is always relative to 2mm squares at the current MM_TO_PX ratio
  const BASE_FONT_PX = 2 * MM_TO_PX * 2.2 * 1.2; // base font size relative to standard 2mm squares
  const fontSize = Math.max(6, Math.min(16, BASE_FONT_PX * labelScale));
  const labelFontSize = fontSize + 2;
  const subFontSize = Math.max(6, Math.min(16, BASE_FONT_PX * subLabelScale));

  // Axis position in grid coords
  const xOriginFrac = (0 - xAxis.min) / (xAxis.max - xAxis.min);
  const yOriginFrac = (0 - yAxis.min) / (yAxis.max - yAxis.min);
  const xOriginPx = gridLeft + xOriginFrac * gridW;
  const yOriginPx = gridBottom - yOriginFrac * gridH;

  // Colors — gridColor handles everything including black
  const gc = gridColor || "#5b8dd9";
  const isBlack = gc === "#222222";
  const axisColor = "#111";
  const textColor = "#111";
  const bgColor = "#fff";

  const TICK_LEN = 6;
  const NUM_PAD = 4;

  // Line weights
  const minorW = 0.3;
  const mediumW = 0.6;
  const majorW = 1.2;
  const axisW = 2.2;
  const tickW = 1.5;
  // Real graph paper: minor very faint, medium slightly visible, major clearly distinct
  const minorOpacity  = isBlack ? 0.18 : 0.25;
  const mediumOpacity = isBlack ? 0.40 : 0.50;
  const majorOpacity  = isBlack ? 0.75 : 0.85;
  const tickLen = TICK_LEN;
  const numPad = NUM_PAD;
  const arrowSize = 7;

  // Leftmost x on the page — aligns with y tick numbers (or sub-label if present)
  const maxYCharsEst = (() => {
    const vals = [];
    for (let i = 0; i <= Math.round((yAxis.max - yAxis.min) / yAxis.interval); i++) {
      const v = Math.round((yAxis.min + i * yAxis.interval) * 1e10) / 1e10;
      vals.push(formatTick(v, yAxis.interval));
    }
    return Math.max(...vals.map(s => s.length));
  })();
  const estNumWidth = maxYCharsEst * fontSize * 0.52;
  const approxYAxisX = xOriginPx < gridLeft ? gridLeft : (xOriginPx > gridRight ? gridRight : xOriginPx);
  const numbersXEst = approxYAxisX - tickLen / 2 - numPad;
  const leftmostX = Math.min(
    xAxis.min < 0 ? gridLeft - arrowSize - 2 : gridLeft,
    ySubLabel ? numbersXEst - estNumWidth - 6 - fontSize : numbersXEst - estNumWidth
  );

  // Extend boundaries — fill right to page edge, let printer clip
  const lineTop    = gridExtend ? 0        : gridTop;
  const lineBottom = gridExtend ? pageH    : gridBottom;
  const lineLeft   = gridExtend ? 0        : gridLeft;
  const lineRight  = gridExtend ? pageW    : gridRight;

  // Build grid lines
  const minorLines = [];
  const mediumLines = [];
  const majorLines = [];

  const xSmallStep = gridW / xSquares;
  const ySmallStep = gridH / ySquares;

  // Vertical lines: tile left and right from the grid if extending
  if (gridExtend) {
    const iStart = -Math.ceil((gridLeft - lineLeft) / xSmallStep) - 1;
    const iEnd   =  xSquares + Math.ceil((lineRight - gridRight) / xSmallStep) + 1;
    for (let i = iStart; i <= iEnd; i++) {
      const x = gridLeft + i * xSmallStep;
      const isMajor = ((i % xAxisF.minor) + xAxisF.minor) % xAxisF.minor === 0;
      const isMedium = xAxisF.medium > 0 && ((i % xAxisF.medium) + xAxisF.medium) % xAxisF.medium === 0 && !isMajor;
      const lineProps = { x1: x, x2: x, y1: lineTop, y2: lineBottom };
      if (isMajor) majorLines.push(lineProps);
      else if (isMedium) mediumLines.push(lineProps);
      else minorLines.push(lineProps);
    }
    const jStart = -Math.ceil((gridTop - lineTop) / ySmallStep) - 1;
    const jEnd   =  ySquares + Math.ceil((lineBottom - gridBottom) / ySmallStep) + 1;
    for (let i = jStart; i <= jEnd; i++) {
      const y = gridTop + i * ySmallStep;
      const isMajor = ((i % yAxisF.minor) + yAxisF.minor) % yAxisF.minor === 0;
      const isMedium = yAxisF.medium > 0 && ((i % yAxisF.medium) + yAxisF.medium) % yAxisF.medium === 0 && !isMajor;
      const lineProps = { x1: lineLeft, x2: lineRight, y1: y, y2: y };
      if (isMajor) majorLines.push(lineProps);
      else if (isMedium) mediumLines.push(lineProps);
      else minorLines.push(lineProps);
    }
  } else {
    // No extension — just lines within the grid
    for (let i = 0; i <= xSquares; i++) {
      const x = i === xSquares ? gridRight : gridLeft + i * xSmallStep; // snap last to exact boundary
      const isMajor = i % xAxisF.minor === 0;
      const isMedium = xAxisF.medium > 0 && i % xAxisF.medium === 0 && !isMajor;
      const lineProps = { x1: x, x2: x, y1: lineTop, y2: lineBottom };
      if (isMajor) majorLines.push(lineProps);
      else if (isMedium) mediumLines.push(lineProps);
      else minorLines.push(lineProps);
    }
    for (let i = 0; i <= ySquares; i++) {
      const y = i === ySquares ? gridBottom : gridTop + i * ySmallStep; // snap last to exact boundary
      const isMajor = i % yAxisF.minor === 0;
      const isMedium = yAxisF.medium > 0 && i % yAxisF.medium === 0 && !isMajor;
      const lineProps = { x1: lineLeft, x2: lineRight, y1: y, y2: y };
      if (isMajor) majorLines.push(lineProps);
      else if (isMedium) mediumLines.push(lineProps);
      else minorLines.push(lineProps);
    }
  }

  // Tick marks and labels on X axis — use index * interval to avoid float accumulation
  const xTicks = [];
  const xTickLabels = [];
  const xTickCount = Math.round((xAxis.max - xAxis.min) / xAxis.interval) + 1;
  for (let xi = 0; xi < xTickCount; xi++) {
    const xVal = Math.round((xAxis.min + xi * xAxis.interval) * 1e10) / 1e10;
    const x = gridLeft + (xi * xAxisF.minor) * xSmallStep;
    const isOrigin = Math.abs(xVal) < 1e-9;
    xTicks.push({ x, isOrigin });
    xTickLabels.push({ x, val: xVal, isOrigin });
  }

  // Tick marks and labels on Y axis — use index * interval to avoid float accumulation
  const yTicks = [];
  const yTickLabels = [];
  const yTickCountDraw = Math.round((yAxis.max - yAxis.min) / yAxis.interval) + 1;
  for (let yi = 0; yi < yTickCountDraw; yi++) {
    const yVal = Math.round((yAxis.min + yi * yAxis.interval) * 1e10) / 1e10;
    const y = gridBottom - (yi * yAxisF.minor) * ySmallStep;
    const isOrigin = Math.abs(yVal) < 1e-9;
    yTicks.push({ y, isOrigin });
    yTickLabels.push({ y, val: yVal, isOrigin });
  }

  // Check if origin is on axes
  const xAxisOnGraph = yOriginPx >= gridTop - 1 && yOriginPx <= gridBottom + 1;
  const yAxisOnGraph = xOriginPx >= gridLeft - 1 && xOriginPx <= gridRight + 1;

  // X axis y position (clamp to graph if origin off-screen)
  const xAxisY = xAxisOnGraph ? yOriginPx : (yAxis.min > 0 ? gridBottom : gridTop);
  const yAxisX = yAxisOnGraph ? xOriginPx : (xAxis.min > 0 ? gridLeft : gridRight);

  return (
    <svg
      width={pageW}
      height={pageH}
      viewBox={`0 0 ${pageW} ${pageH}`}
      style={{ background: bgColor, fontFamily: "'Georgia', serif" }}
      id="smartaxes-svg"
    >
      {/* White background */}
      <rect width={pageW} height={pageH} fill={bgColor} />

      {/* Worksheet header — left aligned with leftmost element on page */}
      {showWorksheet && (
        <g>
          <text
            x={leftmostX} y={printMargin + 20}
            textAnchor="start" fontSize={11} fill={textColor} fontFamily={SANS}
          >
            Name: ___________________________________
          </text>
          {instruction && (
            <text
              x={leftmostX} y={printMargin + 42}
              textAnchor="start" fontSize={11} fill={textColor} fontStyle="italic" fontFamily={SANS}
            >
              {instruction}
            </text>
          )}
        </g>
      )}

      {/* Clip grid to graph area — expanded by half stroke width so edge lines aren't clipped */}
      <defs>
        <clipPath id="gridClip">
          <rect x={lineLeft - majorW/2} y={lineTop - majorW/2} width={lineRight - lineLeft + majorW} height={lineBottom - lineTop + majorW} />
        </clipPath>
        {gridExtend && showGrid && (() => {
          const pw = xSmallStep;
          const ph = ySmallStep;
          const minor = xAxisF.minor;
          const medium = xAxisF.medium;
          const yMinor = yAxisF.minor;
          const yMedium = yAxisF.medium;
          return (
            <pattern id="gridPattern" x={gridLeft % pw} y={gridTop % ph} width={pw} height={ph} patternUnits="userSpaceOnUse">
              <rect width={pw} height={ph} fill="white" />
              {/* minor lines */}
              <line x1={pw} y1={0} x2={pw} y2={ph} stroke={gc} strokeWidth={minorW} opacity={minorOpacity} />
              <line x1={0} y1={ph} x2={pw} y2={ph} stroke={gc} strokeWidth={minorW} opacity={minorOpacity} />
            </pattern>
          );
        })()}
      </defs>

      {/* Grid */}
      {showGrid && (
        gridExtend ? (
          // In extend mode use SVG pattern — tiles perfectly to page edge with zero gaps
          <g>
            <rect x={0} y={0} width={pageW} height={pageH} fill="url(#gridPattern)" />
            {/* Overlay medium and major lines on top of pattern */}
            {showMediumGrid && mediumLines.map((l, i) => (
              <line key={`md${i}`} {...l} stroke={gc} strokeWidth={mediumW} opacity={mediumOpacity} />
            ))}
            {majorLines.map((l, i) => (
              <line key={`mj${i}`} {...l} stroke={gc} strokeWidth={majorW} opacity={majorOpacity} />
            ))}
          </g>
        ) : (
          <g clipPath="url(#gridClip)">
            {showMinorGrid && minorLines.map((l, i) => (
              <line key={`mn${i}`} {...l} stroke={gc} strokeWidth={minorW} opacity={minorOpacity} />
            ))}
            {showMinorGrid && !showMediumGrid && mediumLines.map((l, i) => (
              <line key={`mdf${i}`} {...l} stroke={gc} strokeWidth={minorW} opacity={minorOpacity} />
            ))}
            {showMediumGrid && mediumLines.map((l, i) => (
              <line key={`md${i}`} {...l} stroke={gc} strokeWidth={mediumW} opacity={mediumOpacity} />
            ))}
            {majorLines.map((l, i) => (
              <line key={`mj${i}`} {...l} stroke={gc} strokeWidth={majorW} opacity={majorOpacity} />
            ))}
          </g>
        )
      )}

      {/* X Axis line + arrowheads as explicit polygons */}
      {xAxisOnGraph && (() => {
        const aw = 4;  // arrow half-width
        const al = 7;  // arrow length tip to base
        const tipR = gridRight + al;
        const tipL = gridLeft - al;
        // Line extends 2px INTO each triangle base so thick stroke is fully hidden
        const overlap = 2;
        const lineX1 = xAxis.min < 0 ? gridLeft : gridLeft;
        const lineX2 = tipR - al + overlap;
        return (
          <g>
            <line x1={lineX1} y1={xAxisY} x2={lineX2} y2={xAxisY} stroke={axisColor} strokeWidth={axisW} />
            <polygon points={`${tipR},${xAxisY} ${tipR-al},${xAxisY-aw} ${tipR-al},${xAxisY+aw}`} fill={axisColor} />
            {/* Left arrow removed — single-headed axes only */}
            {/* xAxis.min < 0 && <polygon points={`${tipL},${xAxisY} ${tipL+al},${xAxisY-aw} ${tipL+al},${xAxisY+aw}`} fill={axisColor} /> */}
          </g>
        );
      })()}

      {/* Y Axis line + arrowheads as explicit polygons */}
      {yAxisOnGraph && (() => {
        const aw = 4;  // arrow half-width
        const al = 7;  // arrow length tip to base
        const tipT = gridTop - al;
        const tipB = gridBottom + al;
        // Line extends 2px INTO each triangle base so thick stroke is fully hidden
        const overlap = 2;
        const lineY2 = tipT + al - overlap; // top (line end nearest top arrow)
        const lineY1 = yAxis.min < 0 ? gridBottom : gridBottom;
        return (
          <g>
            <line x1={yAxisX} y1={lineY1} x2={yAxisX} y2={lineY2} stroke={axisColor} strokeWidth={axisW} />
            <polygon points={`${yAxisX},${tipT} ${yAxisX-aw},${tipT+al} ${yAxisX+aw},${tipT+al}`} fill={axisColor} />
            {/* Down arrow removed — single-headed axes only */}
            {/* yAxis.min < 0 && <polygon points={`${yAxisX},${tipB} ${yAxisX-aw},${tipB-al} ${yAxisX+aw},${tipB-al}`} fill={axisColor} /> */}
          </g>
        );
      })()}

      {/* X Axis ticks and labels */}
      {xTicks.map((t, i) => {
        const label = xTickLabels[i];
        const isOrigin = label.isOrigin;
        // Don't double-label origin
        const showLabel = true;
        const yAxisHere = isOrigin && yAxisOnGraph;
        return (
          <g key={`xt${i}`}>
            {xAxisOnGraph && (
              <line
                x1={t.x} y1={xAxisY - tickLen / 2}
                x2={t.x} y2={xAxisY + tickLen / 2}
                stroke={axisColor} strokeWidth={tickW}
              />
            )}
            {showLabel && !isOrigin && (
              <text
                x={t.x}
                y={xAxisY + tickLen / 2 + 3 + fontSize}
                textAnchor="middle"
                fontSize={fontSize}
                fontWeight={labelBold ? "bold" : "normal"}
                fill={textColor}
                fontFamily={SERIF}
              >
                {formatTick(label.val, xAxis.interval)}
              </text>
            )}
          </g>
        );
      })}

      {/* Y Axis ticks and labels */}
      {yTicks.map((t, i) => {
        const label = yTickLabels[i];
        const isOrigin = label.isOrigin;
        return (
          <g key={`yt${i}`}>
            {yAxisOnGraph && (
              <line
                x1={yAxisX - tickLen / 2} y1={t.y}
                x2={yAxisX + tickLen / 2} y2={t.y}
                stroke={axisColor} strokeWidth={tickW}
              />
            )}
            {!isOrigin && (
              <text
                x={yAxisX - tickLen / 2 - numPad}
                y={t.y + fontSize * 0.35}
                textAnchor="end"
                fontSize={fontSize}
                fontWeight={labelBold ? "bold" : "normal"}
                fill={textColor}
                fontFamily={SERIF}
              >
                {formatTick(label.val, yAxis.interval)}
              </text>
            )}
          </g>
        );
      })}

      {/* Origin / zero labels
          - If both axes cross (true origin): single "0" bottom-left of intersection
          - If axes start from corner (e.g. 0,0 minimum): separate "0" on each axis
          - axesCorner = axes meet at bottom-left corner (both mins are 0 or positive, origin at grid corner)
      */}
      {(() => {
        const bothOnGraph = xAxisOnGraph && yAxisOnGraph;
        const atCorner = bothOnGraph && (
          Math.abs(xOriginPx - gridLeft) < 2 || Math.abs(xOriginPx - gridRight) < 2 ||
          Math.abs(yOriginPx - gridTop) < 2 || Math.abs(yOriginPx - gridBottom) < 2
        );

        if (bothOnGraph && !atCorner) {
          // True crossing — single 0 at intersection
          return (
            <text
              x={yAxisX - tickLen / 2 - numPad}
              y={xAxisY + tickLen / 2 + 3 + fontSize}
              textAnchor="end"
              fontSize={fontSize}
              fontWeight={labelBold ? "bold" : "normal"}
              fill={textColor}
              fontFamily={SERIF}
            >
              0
            </text>
          );
        }

        if (bothOnGraph && atCorner) {
          // Corner — separate 0 on x axis (below) and 0 on y axis (to the left)
          return (
            <g>
              {/* X axis zero — matches regular x tick label position exactly */}
              <text
                x={yAxisX}
                y={xAxisY + tickLen / 2 + 3 + fontSize}
                textAnchor="middle"
                fontSize={fontSize}
                fontWeight={labelBold ? "bold" : "normal"}
                fill={textColor}
                fontFamily={SERIF}
              >
                0
              </text>
              {/* Y axis zero — aligned like other y tick labels */}
              <text
                x={yAxisX - tickLen / 2 - numPad}
                y={xAxisY + fontSize * 0.35}
                textAnchor="end"
                fontSize={fontSize}
                fontWeight={labelBold ? "bold" : "normal"}
                fill={textColor}
                fontFamily={SERIF}
              >
                0
              </text>
            </g>
          );
        }

        return null;
      })()}

      {/* X axis end label — just below the line, near the arrow tip */}
      {xAxisOnGraph && xLabel && (
        <text
          x={gridRight + arrowSize + 7}
          y={xAxisY + fontSize}
          textAnchor="middle"
          fontSize={labelFontSize}
          fontStyle="italic"
          fill={textColor}
          fontFamily={SERIF}
          fontWeight={labelBold ? "bold" : "normal"}
        >
          {xLabel}
        </text>
      )}

      {/* Y axis end label — to the left of the axis, slightly above the arrow tip */}
      {yAxisOnGraph && yLabel && (
        <text
          x={yAxisX - 5}
          y={gridTop - arrowSize - fontSize * 0.5}
          textAnchor="end"
          fontSize={labelFontSize}
          fontStyle="italic"
          fill={textColor}
          fontFamily={SERIF}
          fontWeight={labelBold ? "bold" : "normal"}
        >
          {yLabel}
        </text>
      )}

      {/* X sub-label — centred on positive part of x axis, never overlapping y axis, wraps if needed */}
      {xSubLabel && (() => {
        const numbersBaselineY = xAxisY + tickLen / 2 + 3 + fontSize;
        const subY = numbersBaselineY + fontSize * 0.4 + 12;
        const posLeft = yAxisX;
        const posRight = gridRight;
        const posCentreX = posLeft + (posRight - posLeft) / 2;
        const availableWidth = posRight - posLeft;
        const estLabelWidth = xSubLabel.length * subFontSize * 0.55;
        const needsWrap = estLabelWidth > availableWidth - 8;
        let line1 = xSubLabel, line2 = null;
        if (needsWrap) {
          const mid = Math.floor(xSubLabel.length / 2);
          const spaceAfter = xSubLabel.indexOf(' ', mid);
          const spaceBefore = xSubLabel.lastIndexOf(' ', mid);
          const splitAt = spaceAfter >= 0 ? spaceAfter : (spaceBefore >= 0 ? spaceBefore : mid);
          if (splitAt > 0 && splitAt < xSubLabel.length) {
            line1 = xSubLabel.slice(0, splitAt).trim();
            line2 = xSubLabel.slice(splitAt).trim();
          }
        }
        return (
          <g>
            <text x={posCentreX} y={subY} textAnchor="middle" fontSize={subFontSize} fontWeight={subLabelBold ? "bold" : "normal"} fill={textColor} fontFamily={SERIF}>
              {line1}
            </text>
            {line2 && (
              <text x={posCentreX} y={subY + subFontSize + 2} textAnchor="middle" fontSize={subFontSize} fontWeight={subLabelBold ? "bold" : "normal"} fill={textColor} fontFamily={SERIF}>
                {line2}
              </text>
            )}
          </g>
        );
      })()}

      {/* Y sub-label — centred on positive part of y axis only, never crossing x axis */}
      {ySubLabel && (() => {
        const maxChars = (() => {
          const allVals = [];
          for (let yi = 0; yi < Math.round((yAxis.max - yAxis.min) / yAxis.interval) + 1; yi++) {
            const v = Math.round((yAxis.min + yi * yAxis.interval) * 1e10) / 1e10;
            allVals.push(formatTick(v, yAxis.interval));
          }
          return Math.max(...allVals.map(s => s.length));
        })();
        const estimatedNumWidth = maxChars * fontSize * 0.52;
        const numbersX = yAxisX - tickLen / 2 - numPad;
        const subX = numbersX - estimatedNumWidth - 6;
        const posTop = gridTop;
        const posBottom = xAxisY;
        const centreY = posTop + (posBottom - posTop) / 2;
        return (
          <text
            x={subX} y={centreY}
            textAnchor="middle" fontSize={subFontSize}
            fill={textColor} fontFamily={SERIF}
            fontWeight={subLabelBold ? "bold" : "normal"}
            transform={`rotate(-90, ${subX}, ${centreY})`}
          >
            {ySubLabel}
          </text>
        );
      })()}
      {/* Title — rendered last so it always sits on top of the grid */}
      {showTitle && titleText && (() => {
        const cx = gridLeft + gridW / 2;
        const titleFontSize = Math.max(10, Math.min(14, gridW / titleText.length * 1.6));
        const charW = titleFontSize * 0.55;
        const estWidth = titleText.length * charW;

        let ty;
        if (titlePosition === "above") {
          // Above the grid — anchor below the y-axis label/arrow
          ty = (yLabel
            ? gridTop - arrowSize - fontSize * 0.5 - labelFontSize - 4
            : gridTop - arrowSize - 6) - 4;
        } else {
          // "on" — place inside graph just below the top
          ty = gridTop + titleFontSize + 6;
        }

        const availW = titlePosition === "on" ? gridRight - yAxisX - 8 : gridW - 8;
        const cx2 = titlePosition === "on" ? yAxisX + (gridRight - yAxisX) / 2 : cx;

        if (estWidth > availW) {
          const words = titleText.split(" ");
          let line1 = "", line2 = "";
          for (let i = words.length - 1; i > 0; i--) {
            if (words.slice(0, i).join(" ").length * charW <= availW) {
              line1 = words.slice(0, i).join(" ");
              line2 = words.slice(i).join(" ");
              break;
            }
          }
          if (!line1) { line1 = titleText; line2 = ""; }
          return (
            <g>
              <text x={cx2} y={ty} textAnchor="middle" fontSize={titleFontSize} fontWeight="700" fill={textColor} fontFamily={SANS}>{line1}</text>
              {line2 && <text x={cx2} y={ty + titleFontSize * 1.3} textAnchor="middle" fontSize={titleFontSize} fontWeight="700" fill={textColor} fontFamily={SANS}>{line2}</text>}
            </g>
          );
        }
        return (
          <text x={cx2} y={ty} textAnchor="middle" fontSize={titleFontSize} fontWeight="700" fill={textColor} fontFamily={SANS}>
            {titleText}
          </text>
        );
      })()}
    </svg>
  );
}

// ============================================================
// PRESETS
// ============================================================
const PRESETS = [
  {
    name: "Quadratics",
    xMin: -5, xMax: 5, yMin: -10, yMax: 25,
    xLabel: "x", yLabel: "y", xSubLabel: "", ySubLabel: "",
    title: "Quadratic Graphs",
    prompt: "Draw me axes for plotting quadratic graphs between x = -5 and 5"
  },
  {
    name: "Distance-Time",
    xMin: 0, xMax: 60, yMin: 0, yMax: 50,
    xLabel: "t", yLabel: "d", xSubLabel: "Time (minutes)", ySubLabel: "Distance (km)",
    title: "Distance-Time Graph",
    prompt: "I need a distance-time graph, time up to 60 minutes, distance up to 50km"
  },
  {
    name: "Conversion Graph",
    xMin: 0, xMax: 10, yMin: 0, yMax: 22,
    xLabel: "", yLabel: "", xSubLabel: "Mass (kg)", ySubLabel: "Mass (pounds)",
    title: "Conversion Graph: kg to pounds",
    prompt: "Conversion graph for kg to pounds up to 10kg"
  },
  {
    name: "Temperature",
    xMin: 0, xMax: 24, yMin: -10, yMax: 40,
    xLabel: "t", yLabel: "T", xSubLabel: "Time (hours)", ySubLabel: "Temperature (°C)",
    title: "Temperature over 24 Hours",
    prompt: "Temperature over 24 hours, ranging from -10°C to 40°C"
  },
];

// Pick a random preset on load
const INITIAL_PRESET = PRESETS[Math.floor(Math.random() * PRESETS.length)];

// ============================================================
// COLLAPSIBLE SECTION
// ============================================================
function Section({ title, children, peek, defaultOpen = false, accent }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: "1px solid #f1f5f9" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px", background: "none", border: "none", cursor: "pointer",
          fontSize: 12, fontWeight: 600, color: "#374151", fontFamily: SANS,
          letterSpacing: "0.01em"
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {accent && <span style={{ width: 3, height: 12, background: accent, borderRadius: 2, display: "inline-block" }} />}
          {title}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "none", color: "#9ca3af" }}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {peek && (
        <div style={{ padding: "0 16px 10px", background: "#fafafa" }}>
          {peek}
        </div>
      )}
      {open && (
        <div style={{ padding: "4px 16px 14px", background: "#fafafa", borderTop: peek ? "1px solid #f1f5f9" : "none" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ============================================================
// FORM CONTROLS
// ============================================================
function Field({ label, children, inline }) {
  return (
    <div style={{ marginBottom: 8, display: inline ? "flex" : "block", alignItems: inline ? "center" : undefined, gap: inline ? 10 : 0 }}>
      <label style={{ fontSize: 11, fontWeight: 500, color: "#6b7280", display: "block", marginBottom: inline ? 0 : 3, minWidth: inline ? 80 : undefined, fontFamily: SANS, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Input({ value, onChange, type = "text", min, max, step, placeholder, style }) {
  return (
    <input
      type={type} value={value} onChange={e => onChange(e.target.value)}
      min={min} max={max} step={step} placeholder={placeholder}
      style={{
        width: "100%", padding: "6px 8px", border: "1px solid #e5e7eb",
        borderRadius: 6, fontSize: 12, color: "#111827",
        background: "#fff", fontFamily: SANS, outline: "none",
        boxSizing: "border-box", transition: "border-color 0.15s",
        ...style
      }}
      onFocus={e => e.target.style.borderColor = "#0d9488"}
      onBlur={e => e.target.style.borderColor = "#e5e7eb"}
    />
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", fontSize: 12, color: "#374151", fontFamily: SANS }}>
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 34, height: 18, borderRadius: 9,
          background: checked ? "#0d9488" : "#d1d5db",
          position: "relative", transition: "background 0.2s", cursor: "pointer", flexShrink: 0
        }}
      >
        <div style={{
          position: "absolute", top: 2, left: checked ? 18 : 2,
          width: 14, height: 14, borderRadius: "50%", background: "#fff",
          transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)"
        }} />
      </div>
      {label}
    </label>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function SmartAxes() {
  const svgContainerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 500, h: 707 });

  // Load font client-side only
  useEffect(() => {
    if (document.getElementById("smartaxes-font")) return;
    const link = document.createElement("link");
    link.id = "smartaxes-font";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
  }, []);

  // Core state
  const [xMin, setXMin] = useState(String(INITIAL_PRESET.xMin));
  const [xMax, setXMax] = useState(String(INITIAL_PRESET.xMax));
  const [yMin, setYMin] = useState(String(INITIAL_PRESET.yMin));
  const [yMax, setYMax] = useState(String(INITIAL_PRESET.yMax));
  const [xLabel, setXLabel] = useState(INITIAL_PRESET.xLabel);
  const [yLabel, setYLabel] = useState(INITIAL_PRESET.yLabel);
  const [xSubLabel, setXSubLabel] = useState(INITIAL_PRESET.xSubLabel);
  const [ySubLabel, setYSubLabel] = useState(INITIAL_PRESET.ySubLabel);

  // Grid options
  const [showGrid, setShowGrid] = useState(true);
  const [showMinorGrid, setShowMinorGrid] = useState(true);
  const [showMediumGrid, setShowMediumGrid] = useState(true);
  const [gridExtend, setGridExtend] = useState(false);
  const [bw, setBw] = useState(false);
  const [gridColor, setGridColor] = useState("#5b8dd9");
  const [alignH, setAlignH] = useState("centre"); // "left" | "centre"
  const [alignV, setAlignV] = useState("centre"); // "bottom" | "centre"

  // Typography
  const [labelScale, setLabelScale] = useState(1.0);
  const [subLabelScale, setSubLabelScale] = useState(1.0);
  const [labelBold, setLabelBold] = useState(false);
  const [subLabelBold, setSubLabelBold] = useState(false);

  // Headers
  const [showTitle, setShowTitle] = useState(false);
  const [titleText, setTitleText] = useState("");
  const [titlePosition, setTitlePosition] = useState("above"); // "above" | "on"
  const [showWorksheet, setShowWorksheet] = useState(false);
  const [instruction, setInstruction] = useState("");

  // AI prompt
  const [aiPrompt, setAiPrompt] = useState(INITIAL_PRESET.prompt);
  const [aiMessage, setAiMessage] = useState("");
  const [activePreset, setActivePreset] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  const [warnings, setWarnings] = useState([]);

  // Reset alignment to auto whenever axis ranges change
  const xMinNum = parseFloat(xMin);
  const yMinNum = parseFloat(yMin);


  // Copied state: null | "working" | "copied" | "saved" | "error"
  const [copied, setCopied] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [paperSize, setPaperSize] = useState("a4-portrait");
  const [paperOpen, setPaperOpen] = useState(false);

  const PAPER_OPTIONS = [
    { id: "a4-portrait",       label: "A4 Portrait" },
    { id: "a4-landscape",      label: "A4 Landscape" },
    { id: "a5-portrait",       label: "A5 Portrait" },
    { id: "a5-landscape",      label: "A5 Landscape" },
    { id: "a5-2up",            label: "A5 Portrait (×2 on A4 Landscape)" },
  ];

  // Measure container
  useEffect(() => {
    const measure = () => {
      if (svgContainerRef.current) {
        const w = svgContainerRef.current.clientWidth; // clientWidth excludes border
        const h = w * (297 / 210); // A4 ratio
        setContainerSize({ w: Math.max(w, 200), h: Math.max(h, 283) });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // URL state sync
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("xmin")) setXMin(params.get("xmin"));
    if (params.get("xmax")) setXMax(params.get("xmax"));
    if (params.get("ymin")) setYMin(params.get("ymin"));
    if (params.get("ymax")) setYMax(params.get("ymax"));
    if (params.get("xl")) setXLabel(params.get("xl"));
    if (params.get("yl")) setYLabel(params.get("yl"));
    if (params.get("xsl")) setXSubLabel(params.get("xsl"));
    if (params.get("ysl")) setYSubLabel(params.get("ysl"));
    if (params.get("bw")) setBw(params.get("bw") === "1");
    if (params.get("ge")) setGridExtend(params.get("ge") === "1");
    if (params.get("ws")) setShowWorksheet(params.get("ws") === "1");
    if (params.get("wi")) setInstruction(params.get("wi"));
    if (params.get("st")) setShowTitle(params.get("st") === "1");
    if (params.get("tt")) setTitleText(params.get("tt"));
    if (params.get("tp")) setTitlePosition(params.get("tp"));
  }, []);

  const allState = { xMin, xMax, yMin, yMax, xLabel, yLabel, xSubLabel, ySubLabel, bw, gridExtend, showWorksheet, instruction, showTitle, titleText, titlePosition };

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("xmin", xMin); params.set("xmax", xMax);
    params.set("ymin", yMin); params.set("ymax", yMax);
    if (xLabel) params.set("xl", xLabel);
    if (yLabel) params.set("yl", yLabel);
    if (xSubLabel) params.set("xsl", xSubLabel);
    if (ySubLabel) params.set("ysl", ySubLabel);
    if (bw) params.set("bw", "1");
    if (gridExtend) params.set("ge", "1");
    if (showWorksheet) params.set("ws", "1");
    if (instruction) params.set("wi", instruction);
    if (showTitle) params.set("st", "1");
    if (titleText) params.set("tt", titleText);
    if (titlePosition !== "above") params.set("tp", titlePosition);
    window.history.replaceState({}, "", "?" + params.toString());
  }, [xMin, xMax, yMin, yMax, xLabel, yLabel, xSubLabel, ySubLabel, bw, gridExtend, showWorksheet, instruction, showTitle, titleText, titlePosition]);

  // Compute axes config
  const axesConfig = useMemo(() => {
    const xn = parseFloat(xMin), xx = parseFloat(xMax);
    const yn = parseFloat(yMin), yx = parseFloat(yMax);
    if (isNaN(xn) || isNaN(xx) || isNaN(yn) || isNaN(yx)) return null;
    return smartCalculateAxes(xn, xx, yn, yx);
  }, [xMin, xMax, yMin, yMax]);

  useEffect(() => {
    if (axesConfig) setWarnings(axesConfig.warnings);
  }, [axesConfig]);

  const graphConfig = useMemo(() => {
    if (!axesConfig) return null;
    return {
      ...axesConfig,
      xLabel, yLabel, xSubLabel, ySubLabel,
      showGrid, showMinorGrid, showMediumGrid,
      gridExtend, bw, gridColor,
      showWorksheet, instruction,
      showTitle, titleText, titlePosition,
      labelScale, subLabelScale, labelBold, subLabelBold,
      alignH, alignV,
    };
  }, [axesConfig, xLabel, yLabel, xSubLabel, ySubLabel, showGrid, showMinorGrid, showMediumGrid, gridExtend, bw, gridColor, showWorksheet, instruction, showTitle, titleText, titlePosition, labelScale, subLabelScale, labelBold, subLabelBold, alignH, alignV]);

  // Apply preset
  const applyPreset = (preset) => {
    setXMin(String(preset.xMin)); setXMax(String(preset.xMax));
    setYMin(String(preset.yMin)); setYMax(String(preset.yMax));
    setXLabel(preset.xLabel); setYLabel(preset.yLabel);
    setXSubLabel(preset.xSubLabel); setYSubLabel(preset.ySubLabel);
    setAiPrompt(preset.prompt);
    setActivePreset(preset.name);
    if (showTitle) setTitleText(preset.title);
  };

  // AI handler
  const handleAI = async () => {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    setAiMessage("");
    setActivePreset(null);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt })
      });
      const parsed = await response.json();
      if (parsed.error) throw new Error(parsed.error);
      setXMin(String(parsed.xMin)); setXMax(String(parsed.xMax));
      setYMin(String(parsed.yMin)); setYMax(String(parsed.yMax));
      setXLabel(parsed.xLabel || ""); setYLabel(parsed.yLabel || "");
      setXSubLabel(parsed.xSubLabel || ""); setYSubLabel(parsed.ySubLabel || "");
      if (showTitle) setTitleText(parsed.title || "");
      setAiMessage(parsed.explanation || "Done!");
    } catch (e) {
      setAiMessage("Hmm, couldn't interpret that. Try being more specific about the axis ranges.");
    }
    setAiLoading(false);
  };

  // Core SVG → data URL helper (used by all export functions)
  const getSVGDataURL = () => {
    const svg = document.getElementById("smartaxes-svg");
    if (!svg) return null;
    const svgData = new XMLSerializer().serializeToString(svg);
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgData);
  };

  // SVG → canvas → PNG data URL at given scale
  const getPNGDataURL = (scale = 3) => new Promise((resolve, reject) => {
    const svg = document.getElementById("smartaxes-svg");
    if (!svg) return reject("No SVG");
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement("canvas");
    canvas.width = containerSize.w * scale;
    canvas.height = containerSize.h * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
  });

  // Download helper — works in sandbox by creating a temporary link
  const triggerDownload = (dataURL, filename) => {
    const a = document.createElement("a");
    a.href = dataURL;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Detect whether image clipboard write is likely to work
  const canCopyToClipboard = !!(navigator.clipboard && window.ClipboardItem);

  // Get canvas blob directly — avoids the data URL round-trip
  const getCanvasBlob = () => new Promise((resolve, reject) => {
    const svg = document.getElementById("smartaxes-svg");
    if (!svg) return reject("No SVG");
    const scale = 3;
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement("canvas");
    canvas.width = containerSize.w * scale;
    canvas.height = containerSize.h * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => blob ? resolve(blob) : reject("toBlob failed"), "image/png");
    };
    img.onerror = reject;
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
  });

  // Copy image to clipboard, fall back to download on mobile / unsupported browsers
  const copyAsPNG = async () => {
    if (copied === "working") return;
    setCopied("working");
    const finish = (status) => { setCopied(status); setTimeout(() => setCopied(null), 2500); };
    try {
      const blob = await getCanvasBlob();
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        finish("copied");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "smartaxes.png";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        finish("saved");
      }
    } catch (e) {
      // Clipboard write failed — fall back to download
      try {
        const blob = await getCanvasBlob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "smartaxes.png";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        finish("saved");
      } catch (e2) { finish("error"); }
    }
  };

  const copyLink = () => {
    try {
      navigator.clipboard.writeText(window.location.href);
    } catch (e) {
      // fallback — prompt
      window.prompt("Copy this link:", window.location.href);
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const downloadSVG = () => {
    const dataURL = getSVGDataURL();
    if (dataURL) triggerDownload(dataURL, "smartaxes.svg");
  };

  const downloadPNG = async () => {
    const pngURL = await getPNGDataURL(3);
    triggerDownload(pngURL, "smartaxes.png");
  };

  const handlePrint = () => window.print();

  // Sidebar width
  const isMobile = typeof window !== "undefined" && window.innerWidth < 700;

  return (
    <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", minHeight: "100vh", background: "#f9fafb", fontFamily: SANS }}>

      {/* SIDEBAR */}
      <div style={{
        width: isMobile ? "100%" : 272, flexShrink: 0, background: "#fff",
        borderRight: "1px solid #f1f5f9", overflowY: "auto",
        boxShadow: "1px 0 0 #f1f5f9"
      }}>
        {/* Header */}
        <div style={{ background: "#0b7a70", borderBottom: "1px solid #085f58", height: 62, display: "flex", alignItems: "center", padding: "0 16px", gap: 12 }}>
          {/* Logo — mini axes icon */}
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
            <rect width="32" height="32" rx="7" fill="rgba(255,255,255,0.1)"/>
            {/* Grid lines */}
            <line x1="8" y1="10" x2="8" y2="24" stroke="rgba(255,255,255,0.2)" strokeWidth="0.7"/>
            <line x1="14" y1="10" x2="14" y2="24" stroke="rgba(255,255,255,0.2)" strokeWidth="0.7"/>
            <line x1="20" y1="10" x2="20" y2="24" stroke="rgba(255,255,255,0.2)" strokeWidth="0.7"/>
            <line x1="8" y1="12" x2="26" y2="12" stroke="rgba(255,255,255,0.2)" strokeWidth="0.7"/>
            <line x1="8" y1="18" x2="26" y2="18" stroke="rgba(255,255,255,0.2)" strokeWidth="0.7"/>
            <line x1="8" y1="24" x2="26" y2="24" stroke="rgba(255,255,255,0.2)" strokeWidth="0.7"/>
            {/* Axes */}
            <line x1="8" y1="8" x2="8" y2="25" stroke="rgba(255,255,255,0.85)" strokeWidth="1.5" strokeLinecap="round"/>
            <line x1="7" y1="24" x2="27" y2="24" stroke="rgba(255,255,255,0.85)" strokeWidth="1.5" strokeLinecap="round"/>
            {/* Arrowheads */}
            <polygon points="8,7 6,11 10,11" fill="rgba(255,255,255,0.85)"/>
            <polygon points="28,24 24,22 24,26" fill="rgba(255,255,255,0.85)"/>
          </svg>
          <div>
            <div style={{ color: "#e6fffd", fontWeight: 700, fontSize: 16, fontFamily: SANS, lineHeight: 1.1, letterSpacing: "-0.01em" }}>SmartAxes</div>
            <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, fontFamily: SANS, marginTop: 2 }}>Graph paper generator</div>
          </div>
        </div>

        {/* TIER 1: AI Input + Examples */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #f1f5f9", background: "#f0fdfa" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#0d9488", marginBottom: 7, letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: SANS }}>
            Smart Setup
          </div>
          {/* Textarea with embedded send button */}
          <div style={{ position: "relative", border: "1px solid #99f6e4", borderRadius: 8, background: "#fff", display: "flex", flexDirection: "column" }}
            onFocus={() => {}} onBlur={() => {}}
          >
            <textarea
              value={aiPrompt}
              onChange={e => { setAiPrompt(e.target.value); setAiMessage(""); }}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAI(); } }}
              placeholder="Describe your graph… e.g. 'Distance-time, 0–2 hours, up to 100 km'"
              rows={3}
              style={{
                width: "100%", padding: "8px 10px 4px 10px", border: "none",
                borderRadius: "8px 8px 0 0", fontSize: 12, color: "#111827", background: "transparent",
                fontFamily: SANS, resize: "none", boxSizing: "border-box", outline: "none",
                lineHeight: 1.5
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 6px 6px" }}>
              <button
                onClick={handleAI}
                disabled={aiLoading}
                title="Generate axes"
                style={{
                  width: 26, height: 26, borderRadius: 7,
                  background: aiLoading ? "#99f6e4" : "#0d9488",
                  border: "none", cursor: aiLoading ? "default" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "background 0.15s", flexShrink: 0
                }}
              >
                {aiLoading ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <circle cx="6" cy="6" r="4" stroke="white" strokeWidth="1.5" strokeDasharray="6 6" strokeLinecap="round">
                      <animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="0.8s" repeatCount="indefinite"/>
                    </circle>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6h8M7 3l3 3-3 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
          {aiMessage && (
            <div style={{ marginTop: 5, fontSize: 11, color: "#0f766e", fontFamily: SANS, display: "flex", alignItems: "center", gap: 3, flexWrap: "nowrap" }}>
              {aiMessage}
            </div>
          )}
          {/* Examples — just populate the prompt, don't apply */}
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#0d9488", marginBottom: 6, letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: SANS }}>Examples</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {PRESETS.map(p => {
                const isActive = aiPrompt === p.prompt;
                return (
                  <button key={p.name} onClick={() => {
                    setAiPrompt(p.prompt);
                    setAiMessage(<span style={{display:"inline-flex",alignItems:"center",gap:3,whiteSpace:"nowrap"}}>Tap <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{display:"inline-block",verticalAlign:"middle"}}><path d="M2 6h8M7 3l3 3-3 3" stroke="#0d9488" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg> to generate</span>);
                  }} style={{
                    padding: "3px 9px", fontSize: 11, borderRadius: 20,
                    border: `1px solid ${isActive ? "#0d9488" : "#99f6e4"}`,
                    background: isActive ? "#f0fdfa" : "#fff",
                    color: isActive ? "#0d9488" : "#0f766e",
                    cursor: "pointer", fontFamily: SANS,
                    whiteSpace: "nowrap", fontWeight: isActive ? 600 : 400,
                    transition: "all 0.15s"
                  }}>
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* TIER 2: Manual Axes Options */}
        <div style={{ padding: "12px 16px 10px", borderBottom: "1px solid #f1f5f9" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", marginBottom: 8, letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: SANS }}>Manual Setup</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 0.6fr", gap: 5 }}>
              <Field label="X min"><Input value={xMin} onChange={v => { setXMin(v); setActivePreset(null); }} type="number" /></Field>
              <Field label="X max"><Input value={xMax} onChange={v => { setXMax(v); setActivePreset(null); }} type="number" /></Field>
              <Field label="Label"><Input value={xLabel} onChange={v => { setXLabel(v); setActivePreset(null); }} /></Field>
            </div>
            <Field label="X sub-label"><Input value={xSubLabel} onChange={v => { setXSubLabel(v); setActivePreset(null); }} /></Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 0.6fr", gap: 5 }}>
              <Field label="Y min"><Input value={yMin} onChange={v => { setYMin(v); setActivePreset(null); }} type="number" /></Field>
              <Field label="Y max"><Input value={yMax} onChange={v => { setYMax(v); setActivePreset(null); }} type="number" /></Field>
              <Field label="Label"><Input value={yLabel} onChange={v => { setYLabel(v); setActivePreset(null); }} /></Field>
            </div>
            <Field label="Y sub-label"><Input value={ySubLabel} onChange={v => { setYSubLabel(v); setActivePreset(null); }} /></Field>
          </div>
        </div>

        {/* TIER 3: Grid & Style */}
        <Section title="Grid & Style" accent="#0d9488" peek={
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Toggle checked={showGrid} onChange={setShowGrid} label="Show grid" />
            <Toggle checked={gridExtend} onChange={setGridExtend} label="Extend grid to page edge" />
            {/* Colour swatches */}
            <Field label="Grid colour">
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  { color: "#5b8dd9", label: "Blue" },
                  { color: "#0d9488", label: "Teal" },
                  { color: "#e05c3a", label: "Red" },
                  { color: "#222222", label: "Black" },
                ].map(({ color, label }) => (
                  <button
                    key={color}
                    title={label}
                    onClick={() => setGridColor(color)}
                    style={{
                      width: 26, height: 26, borderRadius: 6, background: color, border: "none",
                      cursor: "pointer", flexShrink: 0, position: "relative",
                      outline: gridColor === color ? `2px solid ${color}` : "2px solid transparent",
                      outlineOffset: 2, transition: "outline 0.1s"
                    }}
                  >
                    {gridColor === color && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ position: "absolute", inset: 0, margin: "auto" }}>
                        <path d="M2 6.5l2.5 2.5 5.5-5.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </Field>
          </div>
        }>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
            <Toggle checked={showMinorGrid} onChange={setShowMinorGrid} label="Minor grid lines" />
            <Toggle checked={showMediumGrid} onChange={setShowMediumGrid} label="Medium grid lines (every 5)" />
            <Field label="Horizontal">
              <div style={{ display: "flex", gap: 4 }}>
                {[["left", "Left"], ["centre", "Centre"]].map(([val, label]) => {
                  const active = (alignH === "auto" ? (xMinNum < 0 ? "centre" : "left") : alignH) === val;
                  return (
                    <button key={val} onClick={() => setAlignH(active ? "auto" : val)} style={{
                      flex: 1, padding: "4px 0", fontSize: 11, border: "1px solid",
                      borderColor: active ? "#0d9488" : "#e5e7eb",
                      background: active ? "#f0fdfa" : "#fff",
                      color: active ? "#0f766e" : "#475569",
                      borderRadius: 4, cursor: "pointer", fontWeight: active ? 600 : 400,
                    }}>{label}</button>
                  );
                })}
              </div>
            </Field>
            <Field label="Vertical">
              <div style={{ display: "flex", gap: 4 }}>
                {[["bottom", "Bottom"], ["centre", "Centre"]].map(([val, label]) => {
                  const active = (alignV === "auto" ? (yMinNum < 0 ? "centre" : "bottom") : alignV) === val;
                  return (
                    <button key={val} onClick={() => setAlignV(active ? "auto" : val)} style={{
                      flex: 1, padding: "4px 0", fontSize: 11, border: "1px solid",
                      borderColor: active ? "#0d9488" : "#e5e7eb",
                      background: active ? "#f0fdfa" : "#fff",
                      color: active ? "#0f766e" : "#475569",
                      borderRadius: 4, cursor: "pointer", fontWeight: active ? 600 : 400,
                    }}>{label}</button>
                  );
                })}
              </div>
            </Field>
          </div>
        </Section>

        {/* TIER 3: Typography */}
        <Section title="Text & Fonts" accent="#0d9488">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={`Numbers & labels — ${Math.round(labelScale * 100)}%`}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="range" min={0.6} max={1.6} step={0.05} value={labelScale}
                  onChange={e => setLabelScale(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: "#0d9488" }} />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#64748b", fontFamily: SANS, whiteSpace: "nowrap", cursor: "pointer" }}>
                  <input type="checkbox" checked={labelBold} onChange={e => setLabelBold(e.target.checked)}
                    style={{ accentColor: "#0d9488", cursor: "pointer" }} />
                  Bold
                </label>
              </div>
            </Field>
            <Field label={`Sub-labels — ${Math.round(subLabelScale * 100)}%`}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="range" min={0.6} max={1.6} step={0.05} value={subLabelScale}
                  onChange={e => setSubLabelScale(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: "#0d9488" }} />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#64748b", fontFamily: SANS, whiteSpace: "nowrap", cursor: "pointer" }}>
                  <input type="checkbox" checked={subLabelBold} onChange={e => setSubLabelBold(e.target.checked)}
                    style={{ accentColor: "#0d9488", cursor: "pointer" }} />
                  Bold
                </label>
              </div>
            </Field>
          </div>
        </Section>

        {/* TIER 3: Headers */}
        <Section title="Titles & Headers" accent="#0d9488">

          {/* Graph Title */}
          <div style={{ marginBottom: 10 }}>
            <Toggle checked={showTitle} onChange={setShowTitle} label="Graph title" />
            {showTitle && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <Field label="Title text">
                  <Input value={titleText} onChange={setTitleText} placeholder="e.g. Distance-Time Graph" />
                </Field>
                <Field label="Position">
                  <div style={{ display: "flex", gap: 6 }}>
                    {["above", "on"].map(pos => (
                      <button key={pos} onClick={() => setTitlePosition(pos)} style={{
                        flex: 1, padding: "5px 8px", fontSize: 11, fontWeight: 600,
                        border: "1px solid " + (titlePosition === pos ? "#0d9488" : "#e5e7eb"),
                        borderRadius: 5, background: titlePosition === pos ? "#f0fdfa" : "#fff",
                        color: titlePosition === pos ? "#0d9488" : "#64748b",
                        cursor: "pointer", fontFamily: SANS
                      }}>
                        {pos === "above" ? "Above grid" : "On grid"}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            )}
          </div>

          {/* Divider */}
          <div style={{ borderTop: "1px solid #e2e8f0", margin: "4px 0 10px" }} />

          {/* Worksheet Header */}
          <Toggle checked={showWorksheet} onChange={setShowWorksheet} label="Worksheet header" />
          {showWorksheet && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8", fontStyle: "italic", fontFamily: SANS }}>
                Adds "Name: ______" above the graph
              </div>
              <Field label="Instructions">
                <textarea
                  value={instruction}
                  onChange={e => setInstruction(e.target.value)}
                  placeholder="e.g. Plot the graph of y = x² + 2x − 3"
                  rows={2}
                  style={{
                    width: "100%", padding: "5px 8px", border: "1px solid #e5e7eb",
                    borderRadius: 5, fontSize: 12, color: "#1e293b", background: "#fff",
                    fontFamily: SANS, resize: "vertical", boxSizing: "border-box"
                  }}
                />
              </Field>
            </div>
          )}
        </Section>

      </div>

      {/* PREVIEW AREA */}
      <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>

        {/* Top bar */}
        <div style={{ width: "100%", maxWidth: 600, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* Paper size picker */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setPaperOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: paperOpen ? "7px 7px 0 0" : 7, fontSize: 12, fontWeight: 500, color: "#374151", cursor: "pointer", fontFamily: SANS, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="0.5" width="9" height="11" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 3.5h5M3.5 6h5M3.5 8.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
              {PAPER_OPTIONS.find(p => p.id === paperSize)?.label}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ opacity: 0.5, transform: paperOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}><path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            {paperOpen && (
              <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 100, minWidth: 220, background: "#fff", border: "1px solid #e5e7eb", borderTop: "none", borderRadius: "0 0 8px 8px", overflow: "hidden", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                {PAPER_OPTIONS.map(opt => (
                  <button key={opt.id} onClick={() => { setPaperSize(opt.id); setPaperOpen(false); }}
                    style={{ width: "100%", padding: "8px 14px", background: opt.id === paperSize ? "#f0fdfa" : "#fff", color: opt.id === paperSize ? "#0d9488" : "#374151", border: "none", borderBottom: "1px solid #f3f4f6", fontSize: 12, fontWeight: opt.id === paperSize ? 600 : 400, cursor: "pointer", fontFamily: SANS, textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between" }}
                    onMouseEnter={e => { if (opt.id !== paperSize) e.currentTarget.style.background = "#f9fafb"; }}
                    onMouseLeave={e => { if (opt.id !== paperSize) e.currentTarget.style.background = "#fff"; }}
                  >
                    {opt.label}
                    {opt.id === paperSize && <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6.5l3 3 5-5.5" stroke="#0d9488" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, position: "relative" }}>
            <button
              onClick={copyAsPNG}
              disabled={copied === "working"}
              style={{
                padding: "6px 12px",
                background: copied === "copied" ? "#0d9488" : copied === "saved" ? "#0d9488" : copied === "error" ? "#ef4444" : "#fff",
                color: copied === "copied" || copied === "saved" || copied === "error" ? "#fff" : "#374151",
                border: `1px solid ${copied === "copied" || copied === "saved" ? "#0d9488" : copied === "error" ? "#ef4444" : "#e5e7eb"}`,
                borderRadius: 7, fontSize: 12, fontWeight: 500,
                cursor: copied === "working" ? "default" : "pointer",
                fontFamily: SANS, display: "flex", alignItems: "center", gap: 5,
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                transition: "background 0.15s, color 0.15s, border-color 0.15s", minWidth: 80
              }}
            >
              {copied === "working" ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                    <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="7 7" strokeLinecap="round">
                      <animateTransform attributeName="transform" type="rotate" from="0 6.5 6.5" to="360 6.5 6.5" dur="0.7s" repeatCount="indefinite"/>
                    </circle>
                  </svg>
                  Working…
                </>
              ) : copied === "copied" ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 7l3 3 5-5.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Copied!
                </>
              ) : copied === "saved" ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 7l3 3 5-5.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Saved!
                </>
              ) : copied === "error" ? (
                <>⚠ Failed</>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M4 4V3a2 2 0 012-2h4a2 2 0 012 2v4a2 2 0 01-2 2h-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                  Copy
                </>
              )}
            </button>
            <div style={{ position: "relative" }}>
              <button onClick={() => setExportOpen(o => !o)} style={{ padding: "6px 12px", background: "#0d9488", color: "#fff", border: "none", borderRadius: exportOpen ? "7px 7px 0 0" : 7, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: SANS, display: "flex", alignItems: "center", gap: 5, boxShadow: "0 1px 2px rgba(0,0,0,0.1)" }}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1v8M3 6l3.5 3.5L10 6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M1 10.5h11" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
                Export
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ opacity: 0.8, transform: exportOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}><path d="M2 3.5l3 3 3-3" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {exportOpen && (
                <div style={{ position: "absolute", top: "100%", right: 0, zIndex: 100, minWidth: 185, background: "#fff", border: "1px solid #e5e7eb", borderTop: "none", borderRadius: "0 0 8px 8px", overflow: "hidden", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                  {[
                    { label: "Download PNG", action: downloadPNG, icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="1" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2"/><path d="M4 5l2.5 2.5L10 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg> },
                    { label: "Download SVG", action: downloadSVG, icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 9V4a1 1 0 011-1h4l3 3v6a1 1 0 01-1 1H3a1 1 0 01-1-1z" stroke="currentColor" strokeWidth="1.2"/><path d="M7 3v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg> },
                    { label: "Print", action: handlePrint, icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="2" y="5" width="9" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M4 5V3a1 1 0 011-1h3a1 1 0 011 1v2M4 8h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg> },
                    { label: linkCopied ? "Link Copied!" : "Copy Link", action: copyLink, icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M5 7.5a3 3 0 004.5-.5l1-1a3 3 0 00-4.5-4L5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M8 5.5a3 3 0 00-4.5.5l-1 1a3 3 0 004.5 4L8 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg> },
                  ].map(({ label, icon, action }) => (
                    <button key={label} onClick={() => { action(); setExportOpen(false); }}
                      style={{ width: "100%", padding: "8px 14px", background: "#fff", color: "#374151", border: "none", borderBottom: "1px solid #f3f4f6", fontSize: 12, cursor: "pointer", fontFamily: SANS, textAlign: "left", display: "flex", alignItems: "center", gap: 9 }}
                      onMouseEnter={e => e.currentTarget.style.background = "#f0fdfa"}
                      onMouseLeave={e => e.currentTarget.style.background = "#fff"}
                    >
                      <span style={{ color: "#6b7280" }}>{icon}</span>{label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Warnings */}
        {warnings.length > 0 && (
          <div style={{ maxWidth: 600, width: "100%", padding: "8px 12px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, fontSize: 12, color: "#92400e", fontFamily: SANS }}>
            ⚠ {warnings.join(" ")}
          </div>
        )}

        {/* SVG Preview */}
        <div
          ref={svgContainerRef}
          style={{
            width: "100%", maxWidth: 600,
            boxShadow: "0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)",
            borderRadius: 4, overflow: "hidden", background: "#fff",
            border: "1px solid #e2e8f0"
          }}
        >
          {graphConfig ? (
            <GraphSVG config={graphConfig} width={containerSize.w} height={containerSize.h} />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300, color: "#94a3b8", fontSize: 13 }}>
              Enter valid axis ranges to see your graph
            </div>
          )}
        </div>

        <div style={{ fontSize: 10, color: "#e5e7eb", fontFamily: SANS }}>
          SmartAxes
        </div>
      </div>
    </div>
  );
}

function btnStyle(bg, color, border) {
  return {
    flex: 1, padding: "7px 10px", background: bg, color, border: `1px solid ${border}`,
    borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
    fontFamily: SANS, letterSpacing: "0.02em"
  };
}
