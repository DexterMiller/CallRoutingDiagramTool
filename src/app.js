import { parseBackupFile } from "./parser.js";

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

const pageMeta = {
  inbound: {
    title: "Inbound Call Flow",
    subtitle: "Calls enter from trunks at the top and flow down to their configured destinations.",
  },
  "after-hours": {
    title: "After-Hours Routing",
    subtitle: "Out-of-office and holiday paths from trunks and IVRs, including fallbacks.",
  },
  extensions: {
    title: "Extension Forwarding",
    subtitle: "Extension profile forwarding for no answer, busy, not registered, away, and out-of-office states.",
  },
};

let currentSystem = null;
let currentPage = "inbound";

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  fileName.textContent = file.name;
  setStatus("Reading backup...");

  try {
    currentSystem = await parseBackupFile(file);
    updateStats(currentSystem);
    emptyState.classList.add("is-hidden");
    diagramPanel.classList.remove("is-hidden");
    setStatus(`Loaded ${file.name} from ${currentSystem.sourceEntry}.`);
    render();
  } catch (error) {
    console.error(error);
    currentSystem = null;
    updateStats(null);
    emptyState.classList.remove("is-hidden");
    diagramPanel.classList.add("is-hidden");
    setStatus(error.message || "Could not read this backup.");
  }
});

searchInput.addEventListener("input", () => render());

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    currentPage = button.dataset.page;
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab === button));
    pageTitle.textContent = pageMeta[currentPage].title;
    pageSubtitle.textContent = pageMeta[currentPage].subtitle;
    render();
  });
});

document.querySelector("#fit-view").addEventListener("click", () => {
  diagramWrap.scrollTo({ top: 0, left: 0, behavior: "smooth" });
});

document.querySelector("#export-svg").addEventListener("click", () => {
  if (!currentSystem) return;
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentPage}-call-routing.svg`;
  a.click();
  URL.revokeObjectURL(url);
});

function render() {
  if (!currentSystem) return;

  const query = searchInput.value.trim().toLowerCase();
  const graph = buildGraph(currentSystem, currentPage);
  const filtered = filterGraph(graph, query);
  renderSvg(filtered);
  renderDetails(currentSystem, currentPage, filtered, query);
  setStatus(statusForGraph(currentSystem, filtered, query));
}

function buildGraph(system, page) {
  if (page === "after-hours") return buildAfterHoursGraph(system);
  if (page === "extensions") return buildExtensionGraph(system);
  return buildInboundGraph(system);
}

function buildInboundGraph(system) {
  const graph = createGraph(system);

  system.trunks.forEach((trunk, trunkIndex) => {
    const trunkId = addNode(graph, {
      key: `trunk:${trunk.number || trunkIndex}`,
      kind: "Trunk",
      title: trunk.name || `Trunk ${trunk.number || trunkIndex + 1}`,
      sub: [trunk.number && `Trunk ${trunk.number}`, trunk.direction].filter(Boolean).join(" | "),
      depth: 0,
      search: [trunk.name, trunk.number, trunk.direction, ...trunk.dids].join(" "),
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
      expandDestination(graph, rule.office, ruleId, 2, "Office hours");
    });
  });

  return graph;
}

function buildAfterHoursGraph(system) {
  const graph = createGraph(system);

  system.trunks.forEach((trunk, trunkIndex) => {
    const trunkId = addNode(graph, {
      key: `trunk-ah:${trunk.number || trunkIndex}`,
      kind: "Trunk",
      title: trunk.name || `Trunk ${trunk.number || trunkIndex + 1}`,
      sub: [trunk.number && `Trunk ${trunk.number}`, "After-hours entry"].filter(Boolean).join(" | "),
      depth: 0,
      search: [trunk.name, trunk.number, ...trunk.dids].join(" "),
    });

    trunk.rules.forEach((rule, ruleIndex) => {
      const ruleId = addNode(graph, {
        key: `did-ah:${trunk.number}:${ruleIndex}`,
        kind: "DID",
        title: rule.match || rule.name || "Any DID",
        sub: rule.name || "DID rule",
        depth: 1,
        search: [rule.name, rule.match, rule.condition].join(" "),
      });
      addEdge(graph, trunkId, ruleId, "DID");
      expandDestination(graph, rule.outOfHours, ruleId, 2, "Out of office");
      expandDestination(graph, rule.holidays, ruleId, 2, "Holiday");
    });
  });

  Object.values(system.ivrs).forEach((ivr) => {
    if (!ivr.outOfHoursRoute && !ivr.holidaysRoute) return;
    const ivrId = addNode(graph, {
      key: `ivr-ah-root:${ivr.number}`,
      kind: "IVR",
      title: `IVR ${ivr.number}`,
      sub: ivr.name || "Digital receptionist",
      depth: 0,
      search: [ivr.number, ivr.name, ivr.prompt].join(" "),
    });
    expandDestination(graph, ivr.outOfHoursRoute, ivrId, 1, "Out of office");
    expandDestination(graph, ivr.holidaysRoute, ivrId, 1, "Holiday");
  });

  return graph;
}

function buildExtensionGraph(system) {
  const graph = createGraph(system);

  Object.values(system.extensions).forEach((extension) => {
    const relevantProfiles = extension.profiles.filter((profile) => profile.routes.length);
    if (!relevantProfiles.length) return;

    const extId = addNode(graph, {
      key: `ext-root:${extension.number}`,
      kind: "Extension",
      title: `Ext ${extension.number}`,
      sub: displayExtension(extension),
      depth: 0,
      search: [extension.number, displayExtension(extension), extension.email, extension.currentProfile].join(" "),
    });

    relevantProfiles.forEach((profile, profileIndex) => {
      const profileId = addNode(graph, {
        key: `profile:${extension.number}:${profileIndex}`,
        kind: "Profile",
        title: profile.name || `Profile ${profileIndex + 1}`,
        sub: [
          profile.noAnswerTimeout && `${profile.noAnswerTimeout}s no answer`,
          profile.ringMyMobile && "rings mobile",
          profile.disableRingGroupCalls && "skips ring groups",
        ].filter(Boolean).join(" | "),
        depth: 1,
        search: [profile.name, profile.noAnswerTimeout].join(" "),
      });
      addEdge(graph, extId, profileId, extension.currentProfile === profile.name ? "Current" : "Profile");

      profile.routes.forEach((route, routeIndex) => {
        const stateId = addNode(graph, {
          key: `state:${extension.number}:${profileIndex}:${routeIndex}`,
          kind: "State",
          title: route.state,
          sub: route.audience,
          depth: 2,
          search: [route.state, route.audience].join(" "),
        });
        addEdge(graph, profileId, stateId, "Route");
        expandDestination(graph, route.destination, stateId, 3, "Forward to");
      });
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

  const expansionKey = `${dest.kind}:${dest.dn}:${depth}`;
  if (graph.expanded.has(expansionKey)) return;
  graph.expanded.add(expansionKey);

  const system = graph.system;

  if (dest.kind === "IVR" && system.ivrs[dest.dn]) {
    const ivr = system.ivrs[dest.dn];
    ivr.options.forEach((option) => {
      expandDestination(graph, option.destination, nodeId, depth + 1, option.digit ? `Press ${option.digit}` : "Menu");
    });
    expandDestination(graph, ivr.officeRoute, nodeId, depth + 1, "Office route");
    expandDestination(graph, ivr.outOfHoursRoute, nodeId, depth + 1, "After-hours");
  } else if (dest.kind === "RingGroup" && system.ringGroups[dest.dn]) {
    const rg = system.ringGroups[dest.dn];
    rg.members.forEach((member) => {
      expandDestination(graph, { kind: "Extension", dn: member }, nodeId, depth + 1, "Member");
    });
    expandDestination(graph, rg.noAnswer, nodeId, depth + 1, "No answer");
  } else if (dest.kind === "Queue" && system.queues[dest.dn]) {
    const queue = system.queues[dest.dn];
    queue.members.forEach((member) => {
      expandDestination(graph, { kind: "Extension", dn: member }, nodeId, depth + 1, "Agent");
    });
    expandDestination(graph, queue.timeoutDestination, nodeId, depth + 1, "Timeout");
  }
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
    return { kind: "IVR", title: `IVR ${dest.dn}`, sub: ivr?.name || "Digital receptionist" };
  }
  if (dest.kind === "RingGroup") {
    const rg = system.ringGroups[dest.dn];
    return { kind: "RingGroup", title: `Ring Group ${dest.dn}`, sub: rg?.name || "" };
  }
  if (dest.kind === "Queue") {
    const queue = system.queues[dest.dn];
    return { kind: "Queue", title: `Queue ${dest.dn}`, sub: queue?.name || "" };
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

  const keep = new Set();
  allNodes.forEach((node) => {
    if (node.search.includes(query)) {
      keep.add(node.id);
      collectNeighbors(graph, node.id, keep);
    }
  });

  return {
    nodes: allNodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  };
}

function collectNeighbors(graph, id, keep) {
  graph.edges.forEach((edge) => {
    if (edge.from === id) keep.add(edge.to);
    if (edge.to === id) keep.add(edge.from);
  });
}

function renderSvg(graph) {
  svg.replaceChildren();

  if (!graph.nodes.length) {
    svg.setAttribute("viewBox", "0 0 900 260");
    svg.innerHTML = `<text x="40" y="70" fill="#66717d" font-size="18">No routes match the current filter.</text>`;
    return;
  }

  const nodeWidth = 220;
  const nodeHeight = 74;
  const hGap = 42;
  const vGap = 96;
  const margin = 38;
  const layers = groupByDepth(graph.nodes);
  const maxLayer = Math.max(...layers.map((layer) => layer.length));
  const width = Math.max(900, margin * 2 + maxLayer * nodeWidth + (maxLayer - 1) * hGap);
  const height = Math.max(420, margin * 2 + layers.length * nodeHeight + (layers.length - 1) * vGap);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  layers.forEach((layer, depth) => {
    const layerWidth = layer.length * nodeWidth + Math.max(0, layer.length - 1) * hGap;
    const startX = (width - layerWidth) / 2;
    layer.forEach((node, index) => {
      node.x = startX + index * (nodeWidth + hGap);
      node.y = margin + depth * (nodeHeight + vGap);
    });
  });

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
    nodeLayer.append(group);
  });
}

function groupByDepth(nodes) {
  const maxDepth = Math.max(...nodes.map((node) => node.depth));
  const layers = Array.from({ length: maxDepth + 1 }, () => []);
  nodes
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
    .forEach((node) => layers[node.depth].push(node));
  return layers.filter(Boolean);
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

  if (page === "inbound") {
    details.append(detailCard("Inbound Summary", [
      `${system.trunks.length} trunks`,
      `${system.trunks.reduce((sum, trunk) => sum + trunk.rules.length, 0)} DID rules`,
      `${Object.keys(system.ivrs).length} IVRs`,
      `${Object.keys(system.ringGroups).length} ring groups`,
      `${Object.keys(system.queues).length} queues`,
    ]));
  } else if (page === "after-hours") {
    const afterHoursRules = system.trunks.flatMap((trunk) => trunk.rules).filter((rule) => rule.outOfHours || rule.holidays);
    details.append(detailCard("After-Hours Summary", [
      `${afterHoursRules.length} trunk rules with after-hours or holiday destinations`,
      `${Object.values(system.ivrs).filter((ivr) => ivr.outOfHoursRoute || ivr.holidaysRoute).length} IVRs with alternate routes`,
    ]));
  } else {
    const profiles = Object.values(system.extensions).reduce((sum, ext) => sum + ext.profiles.filter((profile) => profile.routes.length).length, 0);
    details.append(detailCard("Forwarding Summary", [
      `${Object.keys(system.extensions).length} extensions`,
      `${profiles} forwarding profiles with configured routes`,
    ]));
  }
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
  return `Showing ${pageMeta[currentPage].title.toLowerCase()} for ${Object.keys(system.extensions).length} extensions.`;
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

function el(tag, attributes = {}, text = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  if (text) node.textContent = text;
  return node;
}
