import fs from "fs";
import path from "path";

const STORE_FILE = path.resolve("./trade-proposals.json");

const DEFAULT_STATE = {
  proposals: []
};

function loadState() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      return { ...DEFAULT_STATE };
    }

    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : []
    };
  } catch (error) {
    console.error("trade-proposal-engine load error:", error.message);
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("trade-proposal-engine save error:", error.message);
  }
}

const state = loadState();

function makeId() {
  return `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createProposal(data = {}) {
  const proposal = {
    id: makeId(),
    token: data.token || "Unknown",
    ca: data.ca || "",
    reason: data.reason || "No reason",
    score: Number(data.score || 0),
    dossier: data.dossier || null,
    createdBy: data.createdBy || "admin",
    createdAt: Date.now(),
    status: "pending",
    execution: null
  };

  state.proposals.push(proposal);
  saveState();

  return proposal;
}

export function getProposal(id) {
  return state.proposals.find(p => p.id === id) || null;
}

export function updateProposal(id, patch = {}) {
  const proposal = getProposal(id);
  if (!proposal) return null;

  Object.assign(proposal, patch);
  saveState();
  return proposal;
}

export function listRecentProposals(limit = 10) {
  return [...state.proposals]
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, limit);
}
