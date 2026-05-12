import { parseBackupFile } from "./parser.js";
import dagre from "https://cdn.jsdelivr.net/npm/dagre@0.8.5/+esm";

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

    const rules = trunk.rules.length ? trunk.rules : [{
      name: "Default inbound route",
      match: trunk.dids.join(", "),
      office: null,
    }];

    rules.forEach((rule, ruleIndex) => {
      const ruleId = addNode(graph, {
        key: `did:${trunk.number}:${ruleIndex}`,
        kind: "DID",
        title: rule.match || rule.name || "Any DID",
        sub: rule.name || rule.condition || "DID rule",
        depth: 1,
        search: [rule.name, rule.match, rule.condition].join(" "),
      });
      addEdge(graph, trunkId, ruleId, "DID");
      if (selectedHoursMode === "all" || selectedHoursMode === "office") {
        expandDestination(graph, rule.office, ruleId, 2, "Office hours");
      }
      if (selectedHoursMode === "all" || selectedHoursMode === "after") {
        expandDestination(graph, rule.outOfHours, ruleId, 2, "After-hours");
      }
      if (selectedHoursMode === "all" || selectedHoursMode === "holiday") {
        expandDestination(graph, rule.holidays, ruleId, 2, "Holiday");
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

function expandDestination(graph, destination, fromId, depth, label) {
  const nodeId = destinationNode(graph, destination, depth);
  if (!nodeId) return;
  addEdge(graph, fromId, nodeId, label);

  const dest = normalizeDestination(destination);
  if (!dest || !dest.dn) return;

  const expansionKey = `${dest.kind}:${dest.dn || dest.external || dest.raw || ""}`;
  if (graph.expanded.has(expansionKey)) return;
  graph.expanded.add(expansionKey);

  const system = graph.system;

  if (dest.kind === "IVR" && system.ivrs[dest.dn]) {
    const ivr = system.ivrs[dest.dn];
    ivr.options.forEach((option) => {
      const optionDest = normalizeDestination(option.destination);
      if (optionDest?.kind === "Extension") return;
      expandDestination(graph, option.destination, nodeId, depth + 1, option.digit ? `Press ${option.digit}` : "Menu");
    });
    expandDestination(graph, ivr.timeoutDestination, nodeId, depth + 1, ivr.timeout ? `Timeout ${ivr.timeout}s` : "Timeout");
    expandDestination(graph, ivr.officeRoute, nodeId, depth + 1, "Office route");
    expandDestination(graph, ivr.outOfHoursRoute, nodeId, depth + 1, "After-hours");
    expandDestination(graph, ivr.breakRoute, nodeId, depth + 1, "Break route");
    expandDestination(graph, ivr.holidaysRoute, nodeId, depth + 1, "Holiday route");
  } else if (dest.kind === "RingGroup" && system.ringGroups[dest.dn] && isExpanded(expansionKey)) {
    const rg = system.ringGroups[dest.dn];
    expandDestination(graph, rg.noAnswer, nodeId, depth + 1, "No answer");
    addMemberSummaryNode(graph, nodeId, depth + 1, "Member", rg.members || [], `ring-members:${dest.dn}`);
  } else if (dest.kind === "Queue" && system.queues[dest.dn]) {
    const queue = system.queues[dest.dn];
    if (isExpanded(expansionKey)) {
      expandDestination(graph, queue.timeoutDestination, nodeId, depth + 1, queue.timeout ? `Timeout ${queue.timeout}s` : "Timeout");
      addMemberSummaryNode(graph, nodeId, depth + 1, "Agent", queue.members || [], `queue-members:${dest.dn}`);
    }
  } else if (dest.kind === "IVR" && system.ivrs[dest.dn] && !isExpanded(expansionKey)) {
    const ivr = system.ivrs[dest.dn];
    expandDestination(graph, ivr.timeoutDestination, nodeId, depth + 1, ivr.timeout ? `Timeout ${ivr.timeout}s` : "Timeout");
  }
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
    const [kind, dn] = node.key.split(":");
    if (dn && ["ivr", "ringgroup", "queue", "did"].includes(kind)) expansionState.add(`${kind[0].toUpperCase()}${kind.slice(1)}:${dn}`);
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

function renderSvg(graph) {
  svg.replaceChildren();

  if (!graph.nodes.length) {
    svg.setAttribute("viewBox", "0 0 900 260");
    svg.innerHTML = `<text x="40" y="70" fill="#66717d" font-size="18">No routes match the current filter.</text>`;
    return;
  }

  const nodeWidth = 240;
  const nodeHeight = 84;
  const margin = 40;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const layout = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: "TB", nodesep: 55, ranksep: 110, marginx: margin, marginy: margin }).setDefaultEdgeLabel(() => ({}));
  graph.nodes.forEach((node) => layout.setNode(node.id, { width: nodeWidth, height: nodeHeight }));
  graph.edges.forEach((edge, idx) => layout.setEdge(edge.from, edge.to, { label: edge.label, id: idx }));
  dagre.layout(layout);
  graph.nodes.forEach((node) => {
    const p = layout.node(node.id);
    node.x = p.x - nodeWidth / 2;
    node.y = p.y - nodeHeight / 2;
  });
  const width = Math.max(900, layout.graph().width + margin * 2);
  const height = Math.max(420, layout.graph().height + margin * 2);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const edgeLayer = el("g", { class: "edges" });
  const nodeLayer = el("g", { class: "nodes" });
  svg.append(edgeLayer, nodeLayer);

  graph.edges.forEach((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return;

    const x1 = from.x + nodeWidth / 2;
    const y1 = from.y + nodeHeight;
    const x2 = to.x + nodeWidth / 2;
    const y2 = to.y;
    const midY = y1 + Math.max(36, (y2 - y1) / 2);
    edgeLayer.append(el("path", {
      class: "edge",
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
    }));

    if (edge.label) {
      edgeLayer.append(el("text", {
        class: "edge-label",
        x: (x1 + x2) / 2,
        y: midY - 6,
        "text-anchor": "middle",
      }, edge.label));
    }
  });

  graph.nodes.forEach((node) => {
    const group = el("g", {
      class: `node kind-${node.kind.toLowerCase()}`,
      transform: `translate(${node.x} ${node.y})`,
    });
    group.append(el("rect", { class: "node-card", width: nodeWidth, height: nodeHeight, rx: 8 }));
    appendWrappedText(group, node.title, 14, 24, 25, "node-title");
    appendWrappedText(group, node.sub, 14, 50, 29, "node-sub");
    if (isExpandableNode(node)) {
      const expanded = isExpanded(node.key.replace(/^did/, "DID").replace(/^ivr/, "IVR").replace(/^ringgroup/, "RingGroup").replace(/^queue/, "Queue"));
      const affordance = el("circle", { class: "expand-dot", cx: nodeWidth - 14, cy: 14, r: 9 });
      affordance.addEventListener("click", (event) => {
        event.stopPropagation();
        const stateKey = node.key.replace(/^did/, "DID").replace(/^ivr/, "IVR").replace(/^ringgroup/, "RingGroup").replace(/^queue/, "Queue");
        if (expansionState.has(stateKey)) expansionState.delete(stateKey);
        else expansionState.add(stateKey);
        render();
      });
      group.append(affordance, el("text", { class: "expand-glyph", x: nodeWidth - 14, y: 18, "text-anchor": "middle" }, expanded ? "−" : "+"));
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

function appendWrappedText(group, value, x, y, maxChars, className) {
  const textNode = el("text", { class: className, x, y });
  const lines = wrap(value || "", maxChars).slice(0, 2);
  lines.forEach((line, index) => {
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
  const scopedRules = scopedTrunks.flatMap((trunk) => trunk.rules);
  const afterHoursRules = scopedRules.filter((rule) => rule.outOfHours || rule.holidays);

  details.append(detailCard(selectedTrunk ? "Trunk Summary" : "All Trunks Summary", [
    `${scopedTrunks.length} trunk${scopedTrunks.length === 1 ? "" : "s"} shown`,
    `${scopedRules.length} DID rules`,
    `${afterHoursRules.length} rules with after-hours or holiday destinations`,
    `${Object.keys(system.ivrs).length} IVRs`,
    `${Object.keys(system.ringGroups).length} ring groups`,
    `${Object.keys(system.queues).length} queues`,
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

  const seen = new Set();

  function renderNode(nodeId) {
    if (seen.has(nodeId)) return '<li><em>Loop detected</em></li>';
    seen.add(nodeId);

    const node = byId.get(nodeId);
    if (!node) return "";

    const children = (outgoing.get(nodeId) || []).map((edge) => {
      const target = byId.get(edge.to);
      const edgeLabel = edge.label ? `<span class=\"edge\">${escapeHtml(edge.label)}:</span> ` : "";
      return `<li>${edgeLabel}${renderNode(edge.to)}</li>`;
    }).join("");

    const subtitle = node.sub ? `<div class=\"sub\">${escapeHtml(node.sub)}</div>` : "";
    const childList = children ? `<ul>${children}</ul>` : "";
    return `<div class=\"node\"><strong>${escapeHtml(node.title)}</strong> <span class=\"kind\">(${escapeHtml(node.kind)})</span>${subtitle}</div>${childList}`;
  }

  const renderedTrees = roots.map((root) => `<li>${renderNode(root.id)}</li>`).join("");
  const exportedAt = new Date().toISOString();

  return `<!doctype html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
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
</style>
</head>
<body>
<h1>3CX Call Routing Tree</h1>
<p class=\"meta\">Page: ${escapeHtml(page)} | Filter: ${escapeHtml(query || "(none)")} | Exported: ${escapeHtml(exportedAt)} | Trunks: ${system.trunks.length}</p>
<ul>${renderedTrees}</ul>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
