import { readFileSync } from "node:fs";
import vm from "node:vm";

verifyStructuredDestinationParsing();
verifyHoursFiltering();

console.log("Routing verification passed.");

function verifyStructuredDestinationParsing() {
  const parserSource = readFileSync("src/parser.js", "utf8")
    .replace("export async function parseBackupFile", "async function parseBackupFile");
  const parserContext = { TextDecoder };
  vm.createContext(parserContext);
  vm.runInContext(parserSource, parserContext);

  const destination = element("Destination", [
    element("To", [], "IVR"),
    element("Internal", [], "", { DN: "802" }),
  ]);

  const parsedDestination = parserContext.parseForwardTypeDestination(destination);
  assert(
    parsedDestination?.kind === "IVR" && parsedDestination?.dn === "802",
    `Expected Ring Group 801 destination to parse as IVR 802, got ${JSON.stringify(parsedDestination)}`,
  );
}

function verifyHoursFiltering() {
  const appSource = readFileSync("src/app.js", "utf8").replace(/import .*?;\r?\n/, "");
  const stubElement = {
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [],
    querySelector: () => null,
    replaceChildren() {},
    append() {},
    setAttribute() {},
    scrollTo() {},
    dataset: {},
    textContent: "",
    value: "",
  };
  const appContext = {
    console,
    Blob: class {},
    URL: { createObjectURL: () => "", revokeObjectURL() {} },
    document: {
      querySelector: () => stubElement,
      createElement: () => ({ ...stubElement, append() {}, click() {} }),
      createElementNS: () => ({ ...stubElement, append() {}, setAttribute() {} }),
    },
  };

  vm.createContext(appContext);
  vm.runInContext(`${appSource}\nglobalThis.__expandAll = (system) => expandAllExpansibleNodes(system, expansionState);`, appContext);

  const system = {
    trunks: [{
      number: "T1",
      name: "Test trunk",
      direction: "Inbound",
      dids: ["*"],
      rules: [{
        name: "Main",
        match: "555",
        condition: "ForwardAll",
        office: { kind: "RingGroup", dn: "801" },
        outOfHours: { kind: "RingGroup", dn: "801" },
        holidays: null,
      }],
    }],
    ivrs: {
      802: {
        number: "802",
        name: "Regular DAY Greeting",
        options: [],
        timeoutDestination: null,
        officeRoute: null,
        outOfHoursRoute: { kind: "IVR", dn: "804" },
        breakRoute: null,
        holidaysRoute: null,
      },
      804: {
        number: "804",
        name: "Night Greeting",
        options: [],
        timeoutDestination: null,
        officeRoute: null,
        outOfHoursRoute: null,
        breakRoute: null,
        holidaysRoute: null,
      },
    },
    ringGroups: {
      801: {
        number: "801",
        name: "Offices",
        members: [],
        officeHoursDestination: null,
        outOfOfficeHoursDestination: { kind: "IVR", dn: "804" },
        holidaysDestination: null,
        noAnswer: { kind: "IVR", dn: "802" },
      },
    },
    queues: {},
    extensions: {},
    routePoints: {},
  };
  appContext.__expandAll(system);

  const officeGraph = appContext.buildTrunkGraph(system, null, "office");
  const officeTitles = Array.from(officeGraph.nodes.values()).map((node) => node.title);
  const officeLabels = officeGraph.edges.map((edge) => edge.label);
  assert(
    officeTitles.includes("Ring Group 801") && officeTitles.includes("IVR 802"),
    `Expected office graph to include Ring Group 801 and IVR 802, got ${officeTitles.join(", ")}`,
  );
  assert(
    !officeTitles.includes("IVR 804") && !officeLabels.includes("After-hours"),
    `Office filter leaked after-hours routes: ${officeTitles.join(", ")} / ${officeLabels.join(", ")}`,
  );

  const allGraph = appContext.buildTrunkGraph(system, null, "all");
  const allTitles = Array.from(allGraph.nodes.values()).map((node) => node.title);
  const allLabels = allGraph.edges.map((edge) => edge.label);
  assert(
    allTitles.includes("IVR 804") && allLabels.includes("After-hours"),
    `All-hours graph should include after-hours routes: ${allTitles.join(", ")} / ${allLabels.join(", ")}`,
  );
}

function element(tagName, children = [], value = "", attrs = {}) {
  return {
    tagName,
    children,
    textContent: value || children.map((child) => child.textContent || "").join(""),
    getAttribute: (name) => attrs[name] || null,
    getElementsByTagName: () => [],
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
