import { parseBackupFile } from "./parser.js";
const dagre = globalThis.dagre;

const fileInput = document.querySelector("#backup-file");
const fileName = document.querySelector("#file-name");
const statusEl = document.querySelector("#status");
const searchInput = document.querySelector("#search");
const emptyState = document.querySelector("#empty-state");
const diagramPanel = document.querySelector("#diagram-panel");
const diagramWrap = document.querySelector("#diagram-wrap");
const svg = document.querySelector("#diagram");
const details = document.querySelector("#details");
const pageTitle = document.querySelector("#page-title");
const pageSubtitle = document.querySelector("#page-subtitle");
const welcomeCard = document.querySelector("#welcome-card");

let currentSystem = null;
let currentPage = "all-trunks";
let lastRenderedGraph = null;
let lastQuery = "";
let hoursMode = "all";
const expansionState = new Set();
let focusedDidNodeId = null;

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  fileName.textContent = file.name;
  setStatus("Reading backup...");

  try {
    currentSystem = await parseBackupFile(file);
    setAppReady(true);
    updateStats(currentSystem);
    emptyState.classList.add("is-hidden");
    diagramPanel.classList.remove("is-hidden");
    welcomeCard.classList.add("is-hidden");
    setStatus(`Loaded ${file.name} from ${currentSystem.sourceEntry}.`);
    buildTrunkTabs(currentSystem);
    render();
  } catch (error) {
    console.error(error);
    currentSystem = null;
    setAppReady(false);
    updateStats(null);
    emptyState.classList.remove("is-hidden");
    diagramPanel.classList.add("is-hidden");
    welcomeCard.classList.remove("is-hidden");
    setStatus(error.message || "Could not read this backup.");
  }
});

searchInput.addEventListener("input", () => render());

const tabsEl = document.querySelector("#tabs");
const hoursTabsEl = document.querySelector("#hours-tabs");

tabsEl.addEventListener("click", (event) => {
  const button = event.target.closest(".tab");
  if (!button) return;
  currentPage = button.dataset.page;
  setActiveTab(button);
  updatePageHeader();
  render();
});

hoursTabsEl.addEventListener("click", (event) => {
  const button = event.target.closest(".subtab");
  if (!button) return;
  hoursMode = button.dataset.hours || "all";
  setActiveHoursTab(button);
  updatePageHeader();
  render();
});

document.querySelector("#fit-view").addEventListener("click", () => {
  diagramWrap.scrollTo({ top: 0, left: 0, behavior: "smooth" });
});
document.querySelector("#expand-all").addEventListener("click", () => {
  if (!currentSystem) return;
  expandAllExpansibleNodes(currentSystem, expansionState);
  render();
});
document.querySelector("#collapse-all").addEventListener("click", () => {
  expansionState.clear();
  render();
});

document.querySelector("#export-html").addEventListener("click", () => {
  if (!currentSystem || !lastRenderedGraph) return;

  const html = buildTreeExportHtml(currentSystem, lastRenderedGraph, currentPage, lastQuery);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentPage}-call-routing-tree.html`;
  a.click();
  URL.revokeObjectURL(url);
});

document.querySelector("#export-pdf").addEventListener("click", () => {
  if (!currentSystem || !lastRenderedGraph) return;
  exportDiagramPdf();
});

function setAppReady(isReady) {
  document.body.classList.toggle("app-ready", isReady);
}

function render() {
  if (!currentSystem) return;

  const query = searchInput.value.trim().toLowerCase();
  const graph = buildGraph(currentSystem, currentPage, hoursMode);
  const filtered = filterGraph(graph, query);
  lastRenderedGraph = filtered;
  lastQuery = query;
  renderSvg(filtered);
  renderDetails(currentSystem, currentPage, filtered, query);
  setStatus(statusForGraph(currentSystem, filtered, query));
}

function buildGraph(system, page, selectedHoursMode = "all") {
  const trunkNumber = page === "all-trunks" ? null : page.replace("trunk:", "");
  return buildTrunkGraph(system, trunkNumber, selectedHoursMode);
}

function shouldShowTrunkRule(rule) {
  const match = String(rule?.match || "").trim();
  const name = String(rule?.name || "").trim();
  return Boolean(match || name);
}

function buildTrunkGraph(system, selectedTrunkNumber = null, selectedHoursMode = "all") {
  const graph = createGraph(system);

  system.trunks
    .filter((trunk, trunkIndex) => !selectedTrunkNumber || String(trunk.number || trunkIndex + 1) === selectedTrunkNumber)
    .forEach((trunk, trunkIndex) => {
    const trunkId = addNode(graph, {
      key: `trunk:${trunk.number || trunkIndex}`,
      kind: "Trunk",
      title: trunk.name || `Trunk ${trunk.number || trunkIndex + 1}`,
      sub: [trunk.number && `Trunk ${trunk.number}`, trunk.direction].filter(Boolean).join(" | "),
      depth: 0,
      search: [trunk.name, trunk.number, trunk.direction].join(" "),
    });

    const trunkKey = trunk.number || trunkIndex;
    const visibleRules = trunk.rules.filter(shouldShowTrunkRule);
    const rules = visibleRules.length
      ? visibleRules
      : [{
      name: "Default inbound route",
      match: trunk.dids.join(", "),
      office: null,
      outOfHours: null,
      holidays: null,
    }];

    rules.forEach((rule, ruleIndex) => {
      const ruleId = addNode(graph, {
        key: `did:${trunkKey}:${ruleIndex}`,
        kind: "DID",
        title: rule.match || rule.name || "Inbound rule",
        sub: rule.name || rule.condition || "DID rule",
        depth: 1,
        search: [rule.name, rule.match, rule.condition].join(" "),
      });
      addEdge(graph, trunkId, ruleId, "DID");
      const didExpansionKey = `DID:${trunkKey}:${ruleIndex}`;
      if (isExpanded(didExpansionKey)) {
        if (selectedHoursMode === "all" || selectedHoursMode === "office") {
          expandDestination(graph, rule.office, ruleId, 2, "Office hours", selectedHoursMode);
        }
        if (selectedHoursMode === "all" || selectedHoursMode === "after") {
          expandDestination(graph, rule.outOfHours, ruleId, 2, "After-hours", selectedHoursMode);
        }
        if (selectedHoursMode === "all" || selectedHoursMode === "holiday") {
          expandDestination(graph, rule.holidays, ruleId, 2, "Holiday", selectedHoursMode);
        }
      }
    });
  });

  return graph;
}

function createGraph(system) {
  return {
    system,
    nodes: new Map(),
    edges: [],
    expanded: new Set(),
  };
}

function addNode(graph, node) {
  const existing = graph.nodes.get(node.key);
  if (existing) {
    existing.depth = Math.min(existing.depth, node.depth);
    existing.search = `${existing.search} ${node.search || ""}`;
    return existing.id;
  }

  const id = `n${graph.nodes.size}`;
  graph.nodes.set(node.key, {
    id,
    key: node.key,
    kind: node.kind,
    title: node.title || node.kind,
    sub: node.sub || "",
    depth: node.depth || 0,
    search: `${node.kind} ${node.title || ""} ${node.sub || ""} ${node.search || ""}`.toLowerCase(),
  });
  return id;
}

function addEdge(graph, from, to, label) {
  if (!from || !to) return;
  const key = `${from}->${to}:${label || ""}`;
  if (graph.edges.some((edge) => edge.key === key)) return;
  graph.edges.push({ key, from, to, label: label || "" });
}

function expandDestination(graph, destination, fromId, depth, label, selectedHoursMode = "all") {
  const nodeId = destinationNode(graph, destination, depth);
  if (!nodeId) return;
  addEdge(graph, fromId, nodeId, label);

  const dest = normalizeDestination(destination);
  if (!dest || !dest.dn) return;

  const expansionKey = `${dest.kind}:${dest.dn || dest.external || dest.raw || ""}`;
  if (graph.expanded.has(expansionKey)) return;
  graph.expanded.add(expansionKey);

  const system = graph.system;

  if (dest.kind === "IVR" && system.ivrs[dest.dn] && isExpanded(expansionKey)) {
    const ivr = system.ivrs[dest.dn];
    ivr.options.forEach((option) => {
      expandDestination(graph, option.destination, nodeId, depth + 1, option.digit ? `Press ${option.digit}` : "Menu", selectedHoursMode);
    });
    expandDestination(graph, ivr.timeoutDestination, nodeId, depth + 1, ivr.timeout ? `Timeout ${ivr.timeout}s` : "Timeout", selectedHoursMode);
    if (shouldShowScheduledRoute(selectedHoursMode, "office")) {
      expandDestination(graph, ivr.officeRoute, nodeId, depth + 1, "Office route", selectedHoursMode);
    }
    if (shouldShowScheduledRoute(selectedHoursMode, "after")) {
      expandDestination(graph, ivr.outOfHoursRoute, nodeId, depth + 1, "After-hours", selectedHoursMode);
    }
    if (selectedHoursMode === "all") {
      expandDestination(graph, ivr.breakRoute, nodeId, depth + 1, "Break route", selectedHoursMode);
    }
    if (shouldShowScheduledRoute(selectedHoursMode, "holiday")) {
      expandDestination(graph, ivr.holidaysRoute, nodeId, depth + 1, "Holiday route", selectedHoursMode);
    }
  } else if (dest.kind === "RingGroup" && system.ringGroups[dest.dn] && isExpanded(expansionKey)) {
    const rg = system.ringGroups[dest.dn];
    if (shouldShowScheduledRoute(selectedHoursMode, "office")) {
      expandDestination(graph, rg.officeHoursDestination, nodeId, depth + 1, "Office hours", selectedHoursMode);
    }
    if (shouldShowScheduledRoute(selectedHoursMode, "after")) {
      expandDestination(graph, rg.outOfOfficeHoursDestination, nodeId, depth + 1, "After-hours", selectedHoursMode);
    }
    if (shouldShowScheduledRoute(selectedHoursMode, "holiday")) {
      expandDestination(graph, rg.holidaysDestination, nodeId, depth + 1, "Holiday", selectedHoursMode);
    }
    expandDestination(graph, rg.noAnswer, nodeId, depth + 1, "No answer", selectedHoursMode);
    addMemberSummaryNode(graph, nodeId, depth + 1, "Member", rg.members || [], `ring-members:${dest.dn}`);
  } else if (dest.kind === "Queue" && system.queues[dest.dn]) {
    const queue = system.queues[dest.dn];
    const queueTimeout = queue.masterTimeout || queue.ringTimeout || "";
    if (isExpanded(expansionKey)) {
      if (shouldShowScheduledRoute(selectedHoursMode, "office")) {
        expandDestination(graph, queue.officeHoursDestination, nodeId, depth + 1, "Office hours", selectedHoursMode);
      }
      if (shouldShowScheduledRoute(selectedHoursMode, "after")) {
        expandDestination(graph, queue.outOfOfficeHoursDestination, nodeId, depth + 1, "After-hours", selectedHoursMode);
      }
      if (shouldShowScheduledRoute(selectedHoursMode, "holiday")) {
        expandDestination(graph, queue.holidaysDestination, nodeId, depth + 1, "Holiday", selectedHoursMode);
      }
      expandDestination(graph, queue.timeoutDestination, nodeId, depth + 1, queueTimeout ? `Timeout ${queueTimeout}s` : "Timeout", selectedHoursMode);
      addMemberSummaryNode(graph, nodeId, depth + 1, "Agent", queue.members || [], `queue-members:${dest.dn}`);
    }
  } else if (dest.kind === "IVR" && system.ivrs[dest.dn] && !isExpanded(expansionKey)) {
    const ivr = system.ivrs[dest.dn];
    expandDestination(graph, ivr.timeoutDestination, nodeId, depth + 1, ivr.timeout ? `Timeout ${ivr.timeout}s` : "Timeout", selectedHoursMode);
  }
}

function shouldShowScheduledRoute(selectedHoursMode, routeHoursMode) {
  return selectedHoursMode === "all" || selectedHoursMode === routeHoursMode;
}

function addMemberSummaryNode(graph, parentId, depth, labelPrefix, members, key) {
  if (!members.length) return;
  const summaryId = addNode(graph, {
    key,
    kind: "Summary",
    title: `${members.length} ${labelPrefix.toLowerCase()}${members.length === 1 ? "" : "s"}`,
    sub: "Expand to inspect full routes",
    depth,
    search: members.join(" "),
  });
  addEdge(graph, parentId, summaryId, labelPrefix);
}

function isExpanded(key) {
  return expansionState.has(key);
}

function destinationNode(graph, destination, depth) {
  const dest = normalizeDestination(destination);
  if (!dest) return null;

  const key = destinationKey(dest);
  const label = destinationLabel(graph.system, dest);
  return addNode(graph, {
    key,
    kind: label.kind,
    title: label.title,
    sub: label.sub,
    depth,
    search: [dest.kind, dest.dn, dest.external, label.title, label.sub].join(" "),
  });
}

function normalizeDestination(destination) {
  if (!destination) return null;
  if (destination.kind === "None") return { kind: "None", dn: "", external: "" };
  if (destination.kind === "External") return destination.external ? destination : null;
  if (["Extension", "IVR", "RingGroup", "Queue", "VoiceMail", "RoutePoint"].includes(destination.kind) && !destination.dn) {
    return { kind: "End", dn: "", external: "", raw: `${destination.kind} unset` };
  }
  return destination;
}

function destinationKey(dest) {
  if (dest.kind === "External") return `external:${dest.external}`;
  if (dest.kind === "None") return "end:none";
  if (dest.kind === "End") return `end:${dest.raw || "unset"}`;
  return `${dest.kind.toLowerCase()}:${dest.dn}`;
}

function destinationLabel(system, dest) {
  if (dest.kind === "External") {
    return { kind: "External", title: "External", sub: dest.external };
  }
  if (dest.kind === "VoiceMail") {
    return { kind: "VoiceMail", title: `Voicemail ${dest.dn}`, sub: displayExtension(system.extensions[dest.dn]) };
  }
  if (dest.kind === "Extension") {
    return { kind: "Extension", title: `Ext ${dest.dn}`, sub: displayExtension(system.extensions[dest.dn]) };
  }
  if (dest.kind === "IVR") {
    const ivr = system.ivrs[dest.dn];
    const extensionList = getIvrExtensions(system, ivr);
    const detail = [ivr?.name || "Digital receptionist", extensionList && `Ext: ${extensionList}`].filter(Boolean).join(" | ");
    return { kind: "IVR", title: `IVR ${dest.dn}`, sub: detail };
  }
  if (dest.kind === "RingGroup") {
    const rg = system.ringGroups[dest.dn];
    const memberList = formatExtensionList(rg?.members || []);
    const detail = [rg?.name || "", memberList && `Ext: ${memberList}`].filter(Boolean).join(" | ");
    return { kind: "RingGroup", title: `Ring Group ${dest.dn}`, sub: detail };
  }
  if (dest.kind === "Queue") {
    const queue = system.queues[dest.dn];
    const memberList = formatExtensionList(queue?.members || []);
    const detail = [queue?.name || "", memberList && `Ext: ${memberList}`].filter(Boolean).join(" | ");
    return { kind: "Queue", title: `Queue ${dest.dn}`, sub: detail };
  }
  if (dest.kind === "RoutePoint") {
    return { kind: "RoutePoint", title: `Route Point ${dest.dn}`, sub: system.routePoints[dest.dn] || "" };
  }
  return { kind: "End", title: dest.raw || dest.kind || "End", sub: "" };
}

function filterGraph(graph, query) {
  const allNodes = Array.from(graph.nodes.values());
  if (!query) {
    return { nodes: allNodes, edges: graph.edges };
  }

  const outgoing = new Map();
  const incoming = new Map();
  graph.edges.forEach((edge) => {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  });

  const keep = new Set();

  const matchingNodes = allNodes.filter((node) => node.search.includes(query));
  const didExactMatches = matchingNodes.filter((node) => node.kind === "DID" && matchesDidQuery(node, query));
  const seedNodes = didExactMatches.length ? didExactMatches : matchingNodes;

  seedNodes.forEach((node) => {
    keep.add(node.id);
    collectAncestors(node.id, incoming, keep);
    collectDescendants(node.id, outgoing, keep);
  });
  seedNodes.forEach((node) => {
    const [kind, ...rest] = node.key.split(":");
    const value = rest.join(":");
    if (kind === "ivr" && value) expansionState.add(`IVR:${value}`);
    if (kind === "ringgroup" && value) expansionState.add(`RingGroup:${value}`);
    if (kind === "queue" && value) expansionState.add(`Queue:${value}`);
    if (kind === "did" && value) expansionState.add(`DID:${value}`);
  });

  return {
    nodes: allNodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  };
}

function collectAncestors(id, incoming, keep) {
  const parents = incoming.get(id) || [];
  parents.forEach((parentId) => {
    if (keep.has(parentId)) return;
    keep.add(parentId);
    collectAncestors(parentId, incoming, keep);
  });
}

function collectDescendants(id, outgoing, keep) {
  const children = outgoing.get(id) || [];
  children.forEach((childId) => {
    if (keep.has(childId)) return;
    keep.add(childId);
    collectDescendants(childId, outgoing, keep);
  });
}

function matchesDidQuery(node, query) {
  const text = `${node.title} ${node.sub}`.toLowerCase();
  const compactText = text.replace(/[^a-z0-9*]/g, "");
  const compactQuery = query.toLowerCase().replace(/[^a-z0-9*]/g, "");
  if (!compactQuery) return false;
  return compactText.includes(compactQuery);
}


function classifyEdge(label = "") {
  const text = String(label || "").toLowerCase();
  if (text.includes("office")) return "office";
  if (text.includes("after")) return "after";
  if (text.includes("holiday")) return "holiday";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("no answer")) return "no-answer";
  return "default";
}

function edgeClass(label = "") {
  return `edge edge-${classifyEdge(label)}`;
}

function cycleDiagnostics(graph) {
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  graph.edges.forEach((edge) => {
    if (adjacency.has(edge.from) && adjacency.has(edge.to)) adjacency.get(edge.from).push(edge.to);
  });

  let index = 0;
  const stack = [];
  const onStack = new Set();
  const ids = new Map();
  const low = new Map();
  const sccs = [];

  function strongConnect(v) {
    ids.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) || []) {
      if (!ids.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), ids.get(w)));
      }
    }

    if (low.get(v) === ids.get(v)) {
      const component = [];
      while (stack.length) {
        const w = stack.pop();
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      sccs.push(component);
    }
  }

  graph.nodes.forEach((node) => {
    if (!ids.has(node.id)) strongConnect(node.id);
  });

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const cycles = [];
  sccs.forEach((component) => {
    if (component.length > 1) {
      const labels = component.map((id) => byId.get(id)?.title || id).sort((a, b) => a.localeCompare(b));
      cycles.push(labels);
      return;
    }
    const only = component[0];
    if ((adjacency.get(only) || []).includes(only)) {
      const label = byId.get(only)?.title || only;
      cycles.push([label]);
    }
  });

  return cycles.sort((a, b) => a.join(" -> ").localeCompare(b.join(" -> ")));
}


function buildAdjacency(edges) {
  const outgoing = new Map();
  const incoming = new Map();
  edges.forEach((edge) => {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  });
  return { outgoing, incoming };
}

function collectConnectedPath(seedId, graph) {
  if (!seedId) return new Set();
  const { outgoing, incoming } = buildAdjacency(graph.edges);
  const keep = new Set([seedId]);
  collectAncestors(seedId, incoming, keep);
  collectDescendants(seedId, outgoing, keep);
  return keep;
}

function nodeSizing(node) {
  const titleLines = wrap(node.title || "", 25).slice(0, 3);
  const subtitleLines = wrap(node.sub || "", 29).slice(0, 3);
  const titleCount = Math.max(1, titleLines.length);
  const subCount = subtitleLines.filter(Boolean).length;
  const titleH = titleCount * 15;
  const subH = subCount ? subCount * 15 : 0;
  const height = Math.max(84, 18 + titleH + (subH ? 9 + subH : 0) + 14);
  return { width: 240, height, titleLines, subtitleLines };
}

function renderSvg(graph) {
  svg.replaceChildren();

  if (!graph.nodes.length) {
    svg.setAttribute("viewBox", "0 0 900 260");
    svg.innerHTML = `<text x="40" y="70" fill="#66717d" font-size="18">No routes match the current filter.</text>`;
    return;
  }

  if (!dagre?.graphlib?.Graph) {
    svg.setAttribute("viewBox", "0 0 900 260");
    svg.innerHTML = `<text x="40" y="70" fill="#a0422a" font-size="16">Layout engine unavailable. Reload and try again.</text>`;
    return;
  }

  const margin = 40;
  const focusedPath = collectConnectedPath(focusedDidNodeId, graph);
  const hasFocus = focusedPath.size > 0;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const layout = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: "TB", nodesep: 55, ranksep: 110, marginx: margin, marginy: margin }).setDefaultEdgeLabel(() => ({}));
  graph.nodes.forEach((node) => {
    node.size = nodeSizing(node);
    layout.setNode(node.id, { width: node.size.width, height: node.size.height });
  });
  graph.edges.forEach((edge, idx) => layout.setEdge(edge.from, edge.to, { label: edge.label, id: idx }));
  dagre.layout(layout);
  graph.nodes.forEach((node) => {
    const p = layout.node(node.id);
    node.x = p.x - node.size.width / 2;
    node.y = p.y - node.size.height / 2;
  });
  const width = Math.max(900, layout.graph().width + margin * 2);
  const height = Math.max(420, layout.graph().height + margin * 2);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const laneLayer = el("g", { class: "lanes" });
  const edgeLayer = el("g", { class: "edges" });
  const nodeLayer = el("g", { class: "nodes" });
  svg.append(laneLayer, edgeLayer, nodeLayer);

  const depths = [...new Set(graph.nodes.map((node) => node.depth))].sort((a, b) => a - b);
  const laneNames = { 0: "Trunks", 1: "DIDs", 2: "Destinations" };
  depths.forEach((depth) => {
    const laneNodes = graph.nodes.filter((node) => node.depth === depth);
    if (!laneNodes.length) return;
    const top = Math.min(...laneNodes.map((n) => n.y)) - 22;
    const bottom = Math.max(...laneNodes.map((n) => n.y + n.size.height)) + 16;
    laneLayer.append(el("rect", { class: "depth-lane", x: 0, y: top, width, height: bottom - top }));
    laneLayer.append(el("text", { class: "depth-lane-label", x: 14, y: top + 16 }, laneNames[depth] || `Depth ${depth}`));
  });

  graph.edges.forEach((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return;

    const x1 = from.x + from.size.width / 2;
    const y1 = from.y + from.size.height;
    const x2 = to.x + to.size.width / 2;
    const y2 = to.y;
    const midY = y1 + Math.max(36, (y2 - y1) / 2);
    const muted = hasFocus && (!focusedPath.has(edge.from) || !focusedPath.has(edge.to));
    edgeLayer.append(el("path", {
      class: `${edgeClass(edge.label)}${muted ? " is-muted" : ""}`,
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
    }));

    if (edge.label) {
      const lx = (x1 + x2) / 2;
      const ly = midY - 6;
      const labelClass = `edge-chip edge-chip-${classifyEdge(edge.label)}${muted ? " is-muted" : ""}`;
      const labelWidth = Math.max(42, edge.label.length * 6.8 + 14);
      edgeLayer.append(el("g", { class: labelClass },
        el("rect", { x: lx - labelWidth / 2, y: ly - 12, rx: 9, width: labelWidth, height: 18 }),
        el("text", { class: "edge-label", x: lx, y: ly, "text-anchor": "middle" }, edge.label),
      ));
    }
  });

  graph.nodes.forEach((node) => {
    const isFocusNode = node.kind === "DID" && focusedDidNodeId === node.id;
    const muted = hasFocus && !focusedPath.has(node.id);
    const group = el("g", {
      class: `node kind-${node.kind.toLowerCase()}${muted ? " is-muted" : ""}${isFocusNode ? " is-focused" : ""}`,
      transform: `translate(${node.x} ${node.y})`,
    });
    group.append(el("rect", { class: "node-card", width: node.size.width, height: node.size.height, rx: 8 }));
    appendWrappedText(group, node.size.titleLines, 14, 24, "node-title");
    appendWrappedText(group, node.size.subtitleLines, 14 + 0, 24 + (node.size.titleLines.length * 15) + 8, "node-sub");
    if (node.kind === "DID") {
      group.addEventListener("click", () => {
        focusedDidNodeId = focusedDidNodeId === node.id ? null : node.id;
        render();
      });
    }
    if (isExpandableNode(node)) {
      const expanded = isExpanded(node.key.replace(/^did/, "DID").replace(/^ivr/, "IVR").replace(/^ringgroup/, "RingGroup").replace(/^queue/, "Queue"));
      const affordance = el("circle", { class: "expand-dot", cx: node.size.width - 14, cy: 14, r: 9 });
      affordance.addEventListener("click", (event) => {
        event.stopPropagation();
        const stateKey = node.key.replace(/^did/, "DID").replace(/^ivr/, "IVR").replace(/^ringgroup/, "RingGroup").replace(/^queue/, "Queue");
        if (expansionState.has(stateKey)) expansionState.delete(stateKey);
        else expansionState.add(stateKey);
        render();
      });
      group.append(affordance, el("text", { class: "expand-glyph", x: node.size.width - 14, y: 18, "text-anchor": "middle" }, expanded ? "−" : "+"));
    }
    nodeLayer.append(group);
  });
}

function isExpandableNode(node) {
  return ["IVR", "RingGroup", "Queue", "DID"].includes(node.kind);
}

function expandAllExpansibleNodes(system, target) {
  Object.keys(system.ivrs).forEach((dn) => target.add(`IVR:${dn}`));
  Object.keys(system.ringGroups).forEach((dn) => target.add(`RingGroup:${dn}`));
  Object.keys(system.queues).forEach((dn) => target.add(`Queue:${dn}`));
  system.trunks.forEach((trunk, trunkIndex) => {
    const trunkNumber = trunk.number || trunkIndex;
    trunk.rules.forEach((_, ruleIndex) => target.add(`DID:${trunkNumber}:${ruleIndex}`));
  });
}

function groupByDepth(graph) {
  const { nodes, edges } = graph;
  const maxDepth = Math.max(...nodes.map((node) => node.depth));
  const layers = Array.from({ length: maxDepth + 1 }, () => []);

  const sortedNodes = nodes
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  sortedNodes.forEach((node) => layers[node.depth].push(node));

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const parentsByNode = new Map(nodes.map((node) => [node.id, []]));
  const childrenByNode = new Map(nodes.map((node) => [node.id, []]));

  edges.forEach((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) return;
    if (to.depth === from.depth + 1) {
      parentsByNode.get(to.id).push(from.id);
      childrenByNode.get(from.id).push(to.id);
    } else if (from.depth === to.depth + 1) {
      parentsByNode.get(from.id).push(to.id);
      childrenByNode.get(to.id).push(from.id);
    }
  });

  const maxIterations = 6;
  for (let i = 0; i < maxIterations; i += 1) {
    for (let depth = 1; depth < layers.length; depth += 1) {
      reorderLayer(layers, depth, parentsByNode);
    }
    for (let depth = layers.length - 2; depth >= 0; depth -= 1) {
      reorderLayer(layers, depth, childrenByNode);
    }
  }

  return layers.filter(Boolean);
}

function reorderLayer(layers, depth, relatedByNode) {
  const orderInRefLayer = new Map();
  layers.forEach((layer) => {
    layer.forEach((node, index) => {
      orderInRefLayer.set(node.id, index);
    });
  });

  layers[depth].sort((a, b) => {
    const scoreA = medianRank(relatedByNode.get(a.id), orderInRefLayer);
    const scoreB = medianRank(relatedByNode.get(b.id), orderInRefLayer);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a.title.localeCompare(b.title, undefined, { numeric: true });
  });
}

function medianRank(ids, orderLookup) {
  if (!ids || !ids.length) return Number.POSITIVE_INFINITY;
  const ranks = ids
    .map((id) => orderLookup.get(id))
    .filter((rank) => Number.isFinite(rank))
    .sort((a, b) => a - b);

  if (!ranks.length) return Number.POSITIVE_INFINITY;
  const mid = Math.floor(ranks.length / 2);
  if (ranks.length % 2) return ranks[mid];
  return (ranks[mid - 1] + ranks[mid]) / 2;
}

function appendWrappedText(group, lines, x, y, className) {
  const textNode = el("text", { class: className, x, y });
  (lines || [""]).forEach((line, index) => {
    textNode.append(el("tspan", { x, dy: index ? 15 : 0 }, line));
  });
  group.append(textNode);
}

function wrap(value, maxChars) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const words = clean.split(" ");
  const lines = [""];
  words.forEach((word) => {
    const current = lines[lines.length - 1];
    if ((current + " " + word).trim().length > maxChars && current) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = (current + " " + word).trim();
    }
  });
  return lines;
}

function renderDetails(system, page, graph, query) {
  details.replaceChildren();
  const showing = query ? `${graph.nodes.length} matching nodes` : `${graph.nodes.length} nodes`;

  details.append(detailCard("Diagram", [
    `${showing} and ${graph.edges.length} links shown.`,
    `Source XML: ${system.sourceEntry}`,
    system.version ? `3CX version: ${system.version}` : "",
  ].filter(Boolean)));

  const selectedTrunk = getSelectedTrunk(system, page);
  const scopedTrunks = selectedTrunk ? [selectedTrunk] : system.trunks;
  const scopedRules = scopedTrunks.flatMap((trunk) => trunk.rules.filter(shouldShowTrunkRule));
  const afterHoursRules = scopedRules.filter((rule) => rule.outOfHours || rule.holidays);

  details.append(detailCard(selectedTrunk ? "Trunk Summary" : "All Trunks Summary", [
    `${scopedTrunks.length} trunk${scopedTrunks.length === 1 ? "" : "s"} shown`,
    `${scopedRules.length} DID rules`,
    `${afterHoursRules.length} rules with after-hours or holiday destinations`,
    `${Object.keys(system.ivrs).length} IVRs`,
    `${Object.keys(system.ringGroups).length} ring groups`,
    `${Object.keys(system.queues).length} queues`,
  ]));

  const cycles = cycleDiagnostics(graph);
  details.append(detailCard("Cycle Diagnostics", [
    cycles.length ? `${cycles.length} cycle${cycles.length === 1 ? "" : "s"} detected` : "No cycles detected",
    ...cycles.map((cycle) => `${cycle.join(" -> ")} -> ${cycle[0]}`),
  ]));
}

function detailCard(title, lines) {
  const card = document.createElement("section");
  card.className = "detail-card";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("ul");
  lines.forEach((line) => {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  });
  card.append(heading, list);
  return card;
}

function statusForGraph(system, graph, query) {
  if (query) return `Filter active: ${graph.nodes.length} nodes match or connect to "${query}".`;
  const selectedTrunk = getSelectedTrunk(system, currentPage);
  if (selectedTrunk) {
    return `Showing call flow for trunk ${selectedTrunk.number || selectedTrunk.name || "(unnumbered)"}.`;
  }
  return `Showing call flow across ${system.trunks.length} trunks.`;
}


function buildTrunkTabs(system) {
  tabsEl.replaceChildren();

  const allButton = createTab("all-trunks", "All Trunks", currentPage === "all-trunks");
  tabsEl.append(allButton);

  system.trunks.forEach((trunk, index) => {
    const number = String(trunk.number || index + 1);
    const label = trunk.name ? `${trunk.name} (${number})` : `Trunk ${number}`;
    tabsEl.append(createTab(`trunk:${number}`, label, currentPage === `trunk:${number}`));
  });

  const exists = tabsEl.querySelector(`[data-page="${currentPage}"]`);
  if (!exists) currentPage = "all-trunks";
  updatePageHeader();
  setActiveTab(tabsEl.querySelector(`[data-page="${currentPage}"]`));
}

function createTab(page, label, active = false) {
  const button = document.createElement("button");
  button.className = `tab${active ? " is-active" : ""}`;
  button.type = "button";
  button.dataset.page = page;
  button.textContent = label;
  return button;
}

function setActiveHoursTab(activeButton) {
  hoursTabsEl.querySelectorAll(".subtab").forEach((tab) => tab.classList.toggle("is-active", tab === activeButton));
}

function setActiveTab(activeButton) {
  tabsEl.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab === activeButton));
}

function getSelectedTrunk(system, page) {
  if (!page || page === "all-trunks") return null;
  const trunkNumber = page.replace("trunk:", "");
  return system.trunks.find((trunk, index) => String(trunk.number || index + 1) === trunkNumber) || null;
}

function updatePageHeader() {
  if (!currentSystem) return;
  const selectedTrunk = getSelectedTrunk(currentSystem, currentPage);
  if (!selectedTrunk) {
    pageTitle.textContent = "All Trunks";
    pageSubtitle.textContent = `Calls enter from trunks at the top and flow down through ${hoursModeLabel(hoursMode)} destinations.`;
    return;
  }

  const trunkLabel = selectedTrunk.name || `Trunk ${selectedTrunk.number || "(unnumbered)"}`;
  pageTitle.textContent = trunkLabel;
  pageSubtitle.textContent = `Call flow for SIP trunk ${selectedTrunk.number || trunkLabel}, filtered to ${hoursModeLabel(hoursMode)} routes.`;
}

function updateStats(system) {
  document.querySelector("#stat-trunks").textContent = system?.trunks.length || 0;
  document.querySelector("#stat-rules").textContent = system?.trunks.reduce((sum, trunk) => sum + trunk.rules.length, 0) || 0;
  document.querySelector("#stat-ext").textContent = system ? Object.keys(system.extensions).length : 0;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function displayExtension(extension) {
  if (!extension) return "";
  return `${extension.firstName || ""} ${extension.lastName || ""}`.trim() || extension.number || "";
}

function formatExtensionList(members) {
  if (!members.length) return "";
  return Array.from(new Set(members)).join(", ");
}

function getIvrExtensions(system, ivr) {
  if (!ivr) return "";
  const extensionDestinations = [
    ...ivr.options.map((option) => normalizeDestination(option.destination)),
    normalizeDestination(ivr.officeRoute),
    normalizeDestination(ivr.outOfHoursRoute),
  ]
    .filter((dest) => dest?.kind === "Extension")
    .map((dest) => dest.dn);

  return formatExtensionList(extensionDestinations);
}

function hoursModeLabel(mode) {
  if (mode === "office") return "office-hours";
  if (mode === "after") return "after-hours";
  if (mode === "holiday") return "holiday";
  return "office-hours, after-hours, and holiday";
}

function el(tag, attributes = {}, text = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  if (text) node.textContent = text;
  return node;
}


function buildTreeExportHtml(system, graph, page, query) {
  const byId = new Map(Array.from(graph.nodes.values()).map((node) => [node.id, node]));
  const outgoing = new Map();
  const incoming = new Set();

  graph.edges.forEach((edge) => {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
    incoming.add(edge.to);
  });

  const roots = Array.from(graph.nodes.values())
    .filter((node) => !incoming.has(node.id))
    .sort((a, b) => a.title.localeCompare(b.title));

  const globallyRendered = new Set();

  function renderNode(nodeId, inPath = new Set()) {
    const node = byId.get(nodeId);
    if (!node) return "";

    if (inPath.has(nodeId)) {
      return `<div class="diag cycle">Cycle detected (${escapeHtml(node.title)} → … → ${escapeHtml(node.title)})</div>`;
    }
    if (globallyRendered.has(nodeId)) {
      return `<div class="diag ref">Reference to previously rendered node. See ${escapeHtml(node.title)} (rendered above).</div>`;
    }

    globallyRendered.add(nodeId);
    const nextPath = new Set(inPath);
    nextPath.add(nodeId);

    const children = (outgoing.get(nodeId) || []).map((edge) => {
      const edgeLabel = edge.label ? `<span class="edge">${escapeHtml(edge.label)}:</span> ` : "";
      return `<li>${edgeLabel}${renderNode(edge.to, nextPath)}</li>`;
    }).join("");

    const subtitle = node.sub ? `<div class="sub">${escapeHtml(node.sub)}</div>` : "";
    const childList = children ? `<ul>${children}</ul>` : "";
    return `<div class="node"><strong>${escapeHtml(node.title)}</strong> <span class="kind">(${escapeHtml(node.kind)})</span>${subtitle}</div>${childList}`;
  }

  const renderedTrees = roots.map((root) => `<li>${renderNode(root.id)}</li>`).join("");
  const exportedAt = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Call Routing Tree Export</title>
<style>
body { font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif; margin: 2rem; color: #1f2937; }
h1 { margin-bottom: 0.25rem; }
.meta { color: #4b5563; margin-bottom: 1rem; }
ul { line-height: 1.45; }
.node { margin: 0.35rem 0; }
.sub { color: #4b5563; margin-left: 0.25rem; font-size: 0.93rem; }
.kind { color: #6b7280; font-size: 0.9rem; }
.edge { color: #374151; font-weight: 600; }
.diag { margin: 0.25rem 0; font-size: 0.93rem; }
.cycle { color: #9a3412; }
.ref { color: #1d4ed8; }
</style>
</head>
<body>
<h1>3CX Call Routing Tree</h1>
<p class="meta">Page: ${escapeHtml(page)} | Filter: ${escapeHtml(query || "(none)")} | Exported: ${escapeHtml(exportedAt)} | Trunks: ${system.trunks.length}</p>
<ul>${renderedTrees}</ul>
</body>
</html>`;
}

function exportDiagramPdf() {
  const legendEnabled = document.querySelector("#pdf-legend")?.checked ?? true;
  const footerEnabled = document.querySelector("#pdf-footer")?.checked ?? true;
  const exportedAt = new Date().toLocaleString();
  const title = pageTitle?.textContent || "Call Routing";
  const subtitle = pageSubtitle?.textContent || "";
  const filterText = searchInput.value.trim() || "(none)";
  const svgMarkup = svg.outerHTML;
  const pageLabel = currentPage === "all-trunks" ? "All Trunks" : currentPage.replace("trunk:", "Trunk ");

  const exportHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Call Routing Diagram PDF Export</title>
<style>
@page { size: landscape; margin: 12mm; }
body { margin: 0; color: #0f172a; font-family: Inter, Segoe UI, Arial, sans-serif; }
.header { border-bottom: 1px solid #cbd5e1; padding-bottom: 8px; margin-bottom: 10px; }
.company { font-weight: 800; letter-spacing: 0.02em; font-size: 14px; }
.meta, .sub { color: #475569; font-size: 11px; }
.sub { margin-top: 4px; }
.diagram { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; break-inside: avoid; }
.diagram svg { width: 100%; height: auto; background: white; }
.legend { margin-top: 8px; display: flex; gap: 14px; flex-wrap: wrap; font-size: 10px; color: #334155; }
.legend-item::before { content: ""; display: inline-block; width: 14px; border-top: 2px solid #64748b; margin-right: 5px; transform: translateY(-2px); }
.legend-item.edge-office::before { border-color: #2563eb; }
.legend-item.edge-after::before { border-color: #7c3aed; border-top-style: dashed; }
.legend-item.edge-holiday::before { border-color: #059669; border-top-style: dashed; }
.legend-item.edge-timeout::before { border-color: #ea580c; border-top-style: dashed; }
.legend-item.edge-no-answer::before { border-color: #dc2626; border-top-style: dotted; }
.footer { margin-top: 8px; padding-top: 6px; border-top: 1px solid #cbd5e1; color: #64748b; font-size: 10px; display: flex; justify-content: space-between; }
.page-num::after { content: "Page " counter(page); }
</style>
</head>
<body>
  <div class="header">
    <div class="company">3CX Call Routing Diagram Tool</div>
    <div class="meta">Tenant source: ${escapeHtml(currentSystem.sourceEntry)} | Exported: ${escapeHtml(exportedAt)} | Scope: ${escapeHtml(pageLabel)} | Filter: ${escapeHtml(filterText)}</div>
    <div class="sub">${escapeHtml(title)} — ${escapeHtml(subtitle)}</div>
  </div>
  <div class="diagram">${svgMarkup}</div>
  ${legendEnabled ? `<div class="legend">
    <span class="legend-item edge-office">Office hours</span>
    <span class="legend-item edge-after">After-hours</span>
    <span class="legend-item edge-holiday">Holiday</span>
    <span class="legend-item edge-timeout">Timeout</span>
    <span class="legend-item edge-no-answer">No answer</span>
  </div>` : ""}
  ${footerEnabled ? `<div class="footer"><span>Generated for client/management sharing</span><span class="page-num"></span></div>` : ""}
</body>
</html>`;

  const printFrame = document.createElement("iframe");
  printFrame.setAttribute("aria-hidden", "true");
  printFrame.style.position = "fixed";
  printFrame.style.right = "0";
  printFrame.style.bottom = "0";
  printFrame.style.width = "0";
  printFrame.style.height = "0";
  printFrame.style.border = "0";

  const cleanup = () => {
    setTimeout(() => printFrame.remove(), 500);
  };

  printFrame.onload = () => {
    const frameWindow = printFrame.contentWindow;
    if (!frameWindow) {
      cleanup();
      return;
    }
    frameWindow.focus();
    frameWindow.print();
    cleanup();
  };

  document.body.appendChild(printFrame);
  printFrame.srcdoc = exportHtml;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
