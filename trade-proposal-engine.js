import fs from "fs";
import path from "path";

const STORE = path.resolve("./trade-proposals.json");

let state = {
  proposals: []
};

function load() {
  try {
    if (fs.existsSync(STORE)) {
      state = JSON.parse(fs.readFileSync(STORE, "utf8"));
    }
  } catch (e) {
    console.error("proposal load error", e.message);
  }
}

function save() {
  fs.writeFileSync(STORE, JSON.stringify(state, null, 2));
}

load();

export function createProposal(data) {
  const proposal = {
    id: "p_" + Date.now(),
    token: data.token,
    ca: data.ca,
    reason: data.reason,
    score: data.score || 70,
    createdAt: Date.now(),
    status: "pending"
  };

  state.proposals.push(proposal);
  save();

  return proposal;
}

export function getProposal(id) {
  return state.proposals.find(p => p.id === id);
}

export function updateProposal(id, patch) {
  const p = getProposal(id);
  if (!p) return null;

  Object.assign(p, patch);
  save();
  return p;
}
